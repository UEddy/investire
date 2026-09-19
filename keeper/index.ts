/**
 * The Investire keeper.
 *
 * Polls for due schedules and submits one execution transaction for each. It
 * holds no state of its own: everything it needs is either in devnet.json, in
 * the environment, or on chain. Restarting it loses nothing, which is the
 * property that lets systemd treat it as disposable and lets the product claim
 * the keeper is a convenience rather than a dependency. Anyone can run this,
 * or a different implementation of it, and a schedule that nobody runs is late
 * rather than lost.
 *
 * One schedule per transaction, deliberately. settle_execution's introspection
 * requires the transaction to hold exactly one begin_execution and one
 * settle_execution and no other paritas instruction at all, so batching two
 * schedules together would be rejected on chain. That strictness is what makes
 * the execution verifiable; giving up batching is the price.
 *
 * Configuration, all from the environment, nothing committed:
 *   KEEPER_RPC_URL              required, the RPC endpoint
 *   KEEPER_KEYPAIR              required, path to the keeper's keypair json
 *   PARITAS_ADDRESS_BOOK        default ./devnet.json
 *   PARITAS_IDL                 default ./target/idl/paritas.json
 *   KEEPER_POLL_SECONDS         default 60
 *   KEEPER_QUOTE_USDC_PER_SHARE default 5.00, see quoteDelivery
 *   KEEPER_QUOTE_<SYMBOL>       per vault override, e.g. KEEPER_QUOTE_SPY
 *
 * Every vault in the address book is served. Each delivers its own first
 * wrapper, which is the one setup-devnet.ts stocks the keeper with.
 *   KEEPER_COMPUTE_UNIT_LIMIT   default 400000
 */
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  AddressBook,
  RetryOptions,
  VaultEntry,
  WrapperEntry,
  vaultsOf,
  currentMultiplierFixed,
  formatAmount,
  keeperFee,
  toEquityUnits,
  withRetry,
} from "../scripts/devnet-lib";

// --- configuration ---------------------------------------------------------

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got ${raw}`);
  }
  return value;
}

const RPC_URL = required("KEEPER_RPC_URL");
const KEYPAIR_PATH = required("KEEPER_KEYPAIR");
const ADDRESS_BOOK_PATH =
  process.env.PARITAS_ADDRESS_BOOK ?? path.resolve("devnet.json");
const IDL_PATH =
  process.env.PARITAS_IDL ?? path.resolve("target/idl/paritas.json");
const POLL_SECONDS = optionalNumber("KEEPER_POLL_SECONDS", 60);
const COMPUTE_UNIT_LIMIT = optionalNumber("KEEPER_COMPUTE_UNIT_LIMIT", 400_000);
const QUOTE_USDC_PER_SHARE = optionalNumber("KEEPER_QUOTE_USDC_PER_SHARE", 5);

// --- logging ---------------------------------------------------------------

/**
 * One line per event, timestamped, no log library. journalctl adds everything
 * else worth having, and a 512MB droplet does not need a logging framework to
 * print a sentence.
 */
function log(level: "info" | "warn" | "error", message: string): void {
  const line = `${new Date().toISOString()} ${level
    .toUpperCase()
    .padEnd(5)} ${message}`;
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

/**
 * withRetry's options with the keeper's logger attached, so a retry notice is
 * a normal timestamped line in the journal rather than a bare console write.
 */
function retryOptions(extra: RetryOptions = {}): RetryOptions {
  return { onRetry: (message) => log("warn", message), ...extra };
}

function describeError(err: unknown): string {
  const anchorCode = (err as { error?: { errorCode?: { code?: string } } })
    ?.error?.errorCode?.code;
  if (anchorCode) {
    return anchorCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0];
}

// --- shutdown --------------------------------------------------------------

/**
 * Stops at the next safe point rather than mid transaction. An execution is
 * atomic on chain, so being killed partway through loses nothing, but exiting
 * cleanly means systemd sees a normal stop instead of a failure and does not
 * count it towards the restart limit.
 */
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) {
      return;
    }
    stopping = true;
    log(
      "info",
      `${signal} received, finishing the current schedule then exiting`
    );
  });
}

async function sleep(seconds: number): Promise<void> {
  // Wakes every second so a signal during a long poll interval is noticed
  // promptly instead of after the full wait.
  for (let i = 0; i < seconds && !stopping; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

// --- helpers ---------------------------------------------------------------

function pow10(exponent: number): bigint {
  let result = 1n;
  for (let i = 0; i < exponent; i++) {
    result *= 10n;
  }
  return result;
}

/**
 * Byte offset of a field inside an Anchor account, read off the IDL rather
 * than written down here.
 *
 * The offset is needed for the getProgramAccounts memcmp that filters on
 * active. Hardcoding it would work until someone adds a field to Schedule,
 * after which the filter would silently match the wrong byte and the keeper
 * would quietly stop seeing due schedules. Deriving it means a layout change
 * either keeps working or fails loudly at startup.
 */
function offsetOfField(
  idl: anchor.Idl,
  account: string,
  field: string
): number {
  const sizes: Record<string, number> = {
    bool: 1,
    u8: 1,
    i8: 1,
    u16: 2,
    i16: 2,
    u32: 4,
    i32: 4,
    u64: 8,
    i64: 8,
    u128: 16,
    i128: 16,
    pubkey: 32,
  };
  const type = (idl.types ?? []).find((t) => t.name === account);
  if (!type || type.type.kind !== "struct") {
    throw new Error(`IDL has no struct named ${account}`);
  }
  let offset = 8; // account discriminator
  for (const f of (type.type.fields ?? []) as {
    name: string;
    type: string;
  }[]) {
    if (f.name === field) {
      return offset;
    }
    const size = sizes[f.type];
    if (size === undefined) {
      throw new Error(
        `cannot compute the offset of ${account}.${field}: field ${f.name} has ` +
          `unsupported type ${JSON.stringify(f.type)}`
      );
    }
    offset += size;
  }
  throw new Error(`${account} has no field named ${field}`);
}

interface ScheduleAccount {
  owner: PublicKey;
  vault: PublicKey;
  paymentMint: PublicKey;
  ownerPaymentAccount: PublicKey;
  scheduleIndex: number;
  amountUsdc: BN;
  cadenceSeconds: BN;
  nextDueTs: BN;
  minEquityUnits: BN;
  totalEquityUnits: BN;
  active: boolean;
  bump: number;
}

/**
 * How many raw wrapper units this execution should deliver.
 *
 * ON MAINNET THIS IS A JUPITER QUOTE. The keeper would ask Jupiter what the
 * schedule's USDC buys, check the answer against the schedule's floor, and
 * build the route. Here there is no venue quoting these mock mints, so the
 * quote is a configured constant price and the delivery comes out of the
 * keeper's own inventory. See buildSwapSubstitute.
 */
function quoteDelivery(
  amountUsdc: bigint,
  paymentDecimals: number,
  wrapper: WrapperEntry,
  quoteUsdcPerShare: number
): bigint {
  const usdcPerShare = BigInt(
    Math.round(quoteUsdcPerShare * Number(pow10(paymentDecimals)))
  );
  return (amountUsdc * pow10(wrapper.decimals)) / usdcPerShare;
}

// --- one execution ---------------------------------------------------------

interface Context {
  connection: Connection;
  program: Program<anchor.Idl>;
  book: AddressBook;
  /** The vault this context executes for. One context per vault. */
  vaultEntry: VaultEntry;
  quoteUsdcPerShare: number;
  keeper: Keypair;
  wrapper: WrapperEntry;
  wrapperMint: PublicKey;
  paymentMint: PublicKey;
  vault: PublicKey;
  receiptMint: PublicKey;
  wrapperPda: PublicKey;
  vaultWrapperAccount: PublicKey;
  keeperPaymentAccount: PublicKey;
  keeperWrapperAccount: PublicKey;
}

/**
 * Checks that this execution can succeed before paying to find out.
 *
 * Every one of these would otherwise surface as a failed transaction: the
 * owner spent their USDC, revoked the delegation, or the quote no longer
 * clears the floor the last execution ratcheted into place. A keeper that
 * submits regardless burns fees and fills the log with on chain failures that
 * look like bugs. Returning a reason instead keeps the log readable and the
 * SOL in the wallet.
 */
async function preflight(
  ctx: Context,
  schedule: ScheduleAccount,
  delivery: bigint,
  expectedEquityUnits: bigint
): Promise<string | null> {
  if (!schedule.vault.equals(ctx.vault)) {
    return `schedule belongs to vault ${schedule.vault.toBase58()}, not ours`;
  }

  const amount = BigInt(schedule.amountUsdc.toString());
  const floor = BigInt(schedule.minEquityUnits.toString());
  if (expectedEquityUnits < floor) {
    return (
      `quote of ${formatAmount(
        expectedEquityUnits,
        ctx.vaultEntry.receiptDecimals
      )} shares is ` +
      `below the schedule floor of ${formatAmount(
        floor,
        ctx.vaultEntry.receiptDecimals
      )}`
    );
  }

  const inventory = await withRetry(
    "keeper inventory",
    () =>
      getAccount(
        ctx.connection,
        ctx.keeperWrapperAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID
      ),
    retryOptions()
  );
  if (inventory.amount < delivery) {
    return (
      `keeper holds ${formatAmount(inventory.amount, ctx.wrapper.decimals)} ${
        ctx.wrapper.label
      }, ` + `needs ${formatAmount(delivery, ctx.wrapper.decimals)} to deliver`
    );
  }

  const ownerAccount = await withRetry(
    "owner payment account",
    () =>
      getAccount(
        ctx.connection,
        schedule.ownerPaymentAccount,
        undefined,
        TOKEN_PROGRAM_ID
      ),
    retryOptions()
  );
  if (ownerAccount.amount < amount) {
    return `owner balance ${formatAmount(
      ownerAccount.amount,
      ctx.book.payment.decimals
    )} is below the buy`;
  }
  const schedulePda = schedulePdaOf(ctx, schedule);
  if (!ownerAccount.delegate || !ownerAccount.delegate.equals(schedulePda)) {
    return "owner has not delegated this schedule on their payment account";
  }
  if (ownerAccount.delegatedAmount < amount) {
    return (
      `delegated allowance ${formatAmount(
        ownerAccount.delegatedAmount,
        ctx.book.payment.decimals
      )} ` + "is exhausted"
    );
  }

  return null;
}

function schedulePdaOf(ctx: Context, schedule: ScheduleAccount): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from(ctx.book.seeds.schedule),
      schedule.owner.toBuffer(),
      schedule.vault.toBuffer(),
      Buffer.from([schedule.scheduleIndex]),
    ],
    ctx.program.programId
  );
  return pda;
}

async function execute(
  ctx: Context,
  schedulePda: PublicKey,
  schedule: ScheduleAccount
): Promise<void> {
  const amount = BigInt(schedule.amountUsdc.toString());
  const delivery = quoteDelivery(
    amount,
    ctx.book.payment.decimals,
    ctx.wrapper,
    ctx.quoteUsdcPerShare
  );

  const now = Math.floor(Date.now() / 1000);
  const multFixed = currentMultiplierFixed(
    ctx.wrapper.mainnet.multiplier,
    ctx.wrapper.mainnet.newMultiplier,
    ctx.wrapper.mainnet.newMultiplierEffectiveTimestamp,
    now
  );
  const expectedEquityUnits = toEquityUnits(
    delivery,
    ctx.wrapper.decimals,
    multFixed
  );

  const blocked = await preflight(ctx, schedule, delivery, expectedEquityUnits);
  if (blocked) {
    log("warn", `skip ${schedulePda.toBase58()}: ${blocked}`);
    return;
  }

  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(ctx.book.seeds.executionEscrow), schedulePda.toBuffer()],
    ctx.program.programId
  );
  const [executionReceiptPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(ctx.book.seeds.executionReceipt), schedulePda.toBuffer()],
    ctx.program.programId
  );
  const ownerReceiptAccount = getAssociatedTokenAddressSync(
    ctx.receiptMint,
    schedule.owner,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  const beginIx = await ctx.program.methods
    .beginExecution()
    .accounts({
      caller: ctx.keeper.publicKey,
      schedule: schedulePda,
      vault: ctx.vault,
      wrapper: ctx.wrapperPda,
      wrapperMint: ctx.wrapperMint,
      paymentMint: ctx.paymentMint,
      owner: schedule.owner,
      ownerPaymentAccount: schedule.ownerPaymentAccount,
      callerPaymentAccount: ctx.keeperPaymentAccount,
      escrow: escrowPda,
      receipt: executionReceiptPda,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      paymentTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  // ===================== DEVNET SUBSTITUTE FOR JUPITER =====================
  //
  // THIS IS NOT A SWAP. On mainnet this slot holds a Jupiter route that sells
  // the USDC begin_execution just handed the keeper and delivers the wrapper
  // into the escrow. Jupiter is not deployed on devnet, and these are mock
  // mints no venue makes a market in, so there is no route to build.
  //
  // What stands in for it is a direct transfer out of the keeper's own
  // inventory into the escrow. The keeper keeps the USDC and gives up the
  // shares, which is the position a keeper ends a real execution in anyway.
  //
  // The program never inspects this instruction. settle_execution measures the
  // escrow balance, values it at the live multiplier and checks it against the
  // floor, and would do exactly that whether the tokens came from Jupiter,
  // another aggregator, or inventory. To go to mainnet, replace this one
  // instruction with the Jupiter swap, destination escrowPda, and change
  // nothing else.
  const swapSubstituteIx = createTransferCheckedInstruction(
    ctx.keeperWrapperAccount,
    ctx.wrapperMint,
    escrowPda,
    ctx.keeper.publicKey,
    delivery,
    ctx.wrapper.decimals,
    [],
    TOKEN_2022_PROGRAM_ID
  );
  // =========================================================================

  const settleIx = await ctx.program.methods
    .settleExecution(new BN(expectedEquityUnits.toString()))
    .accounts({
      caller: ctx.keeper.publicKey,
      schedule: schedulePda,
      receipt: executionReceiptPda,
      vault: ctx.vault,
      wrapper: ctx.wrapperPda,
      wrapperMint: ctx.wrapperMint,
      escrow: escrowPda,
      vaultWrapperAccount: ctx.vaultWrapperAccount,
      receiptMint: ctx.receiptMint,
      owner: schedule.owner,
      ownerReceiptAccount,
      paymentMint: ctx.paymentMint,
      ownerPaymentAccount: schedule.ownerPaymentAccount,
      callerPaymentAccount: ctx.keeperPaymentAccount,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      paymentTokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  // One schedule per transaction. The introspection scan in settle_execution
  // rejects any other paritas instruction here, so a second schedule's
  // begin_execution would fail the whole batch.
  const transaction = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    beginIx,
    swapSubstituteIx,
    settleIx
  );
  transaction.feePayer = ctx.keeper.publicKey;

  const signature = await withRetry(
    `execute ${schedulePda.toBase58()}`,
    () => {
      transaction.recentBlockhash = undefined;
      transaction.lastValidBlockHeight = undefined;
      transaction.signatures = [];
      return sendAndConfirmTransaction(ctx.connection, transaction, [
        ctx.keeper,
      ]);
    },
    // No idempotent flag. An execution is not replayable: resending one whose
    // outcome is unknown could debit the owner twice if the first copy landed.
    // The schedule's next_due_ts already moved, so the duplicate would fail on
    // chain rather than double spend, but the correct behaviour is still to
    // report it and let the next poll re-read the truth from the schedule.
    retryOptions()
  );

  // Read the credited amount back off the schedule rather than reporting what
  // was expected. The two agree here, but a log that prints its own assumption
  // is not evidence of anything.
  const after = (await withRetry(
    "re-read schedule",
    () => (ctx.program.account as any).schedule.fetch(schedulePda),
    retryOptions()
  )) as ScheduleAccount;
  const credited =
    BigInt(after.totalEquityUnits.toString()) -
    BigInt(schedule.totalEquityUnits.toString());

  const fee = keeperFee(
    amount,
    BigInt(ctx.vaultEntry.keeperFeeBps),
    BigInt(ctx.vaultEntry.keeperFeeMin)
  );

  log(
    "info",
    `executed ${schedulePda.toBase58()} ` +
      `owner=${schedule.owner.toBase58()} ` +
      `amount=${formatAmount(amount, ctx.book.payment.decimals)} ${
        ctx.book.payment.label
      } ` +
      `equity=${formatAmount(credited, ctx.vaultEntry.receiptDecimals)} ${
        ctx.vaultEntry.symbol
      } ` +
      `fee=${formatAmount(fee, ctx.book.payment.decimals)} ${
        ctx.book.payment.label
      } ` +
      `sig=${signature}`
  );
}

// --- the poll loop ---------------------------------------------------------

async function pollOnce(
  contexts: Context[],
  activeOffset: number
): Promise<void> {
  const first = contexts[0];
  const accounts = await withRetry(
    "fetch due schedules",
    () =>
      (first.program.account as any).schedule.all([
        {
          memcmp: {
            offset: activeOffset,
            bytes: anchor.utils.bytes.bs58.encode(Buffer.from([1])),
          },
        },
      ]),
    retryOptions()
  );

  // Routed by vault. A schedule on a vault this address book does not list is
  // not ours to run, and is left alone rather than executed against the wrong
  // wrapper.
  const byVault = new Map(contexts.map((ctx) => [ctx.vault.toBase58(), ctx]));
  const now = Math.floor(Date.now() / 1000);
  const due = (accounts as { publicKey: PublicKey; account: ScheduleAccount }[])
    .filter((entry) => byVault.has(entry.account.vault.toBase58()))
    .filter((entry) => entry.account.nextDueTs.toNumber() <= now)
    // Oldest due first, so a backlog is worked through in the order the owners
    // were promised rather than in whatever order the RPC returned.
    .sort(
      (a, b) => a.account.nextDueTs.toNumber() - b.account.nextDueTs.toNumber()
    );

  if (due.length === 0) {
    return;
  }
  log("info", `${due.length} schedule(s) due`);

  for (const entry of due) {
    if (stopping) {
      log("info", "stopping, leaving the rest for the next run");
      return;
    }
    const ctx = byVault.get(entry.account.vault.toBase58())!;
    try {
      await execute(ctx, entry.publicKey, entry.account);
    } catch (err) {
      // One schedule's problem is its own. A revoked delegation, an owner who
      // spent their balance, a slot where the swap leg reverts: none of it is
      // a reason to stop serving everybody else.
      log(
        "error",
        `failed ${entry.publicKey.toBase58()}: ${describeError(err)}`
      );
    }
  }
}

async function main(): Promise<void> {
  const book: AddressBook = JSON.parse(
    fs.readFileSync(ADDRESS_BOOK_PATH, "utf8")
  );
  const idl: anchor.Idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));

  const keeper = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")))
  );

  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(keeper),
    { commitment: "confirmed" }
  );
  const program = new Program(idl, provider) as Program<anchor.Idl>;

  if (program.programId.toBase58() !== book.programId) {
    throw new Error(
      `the IDL is for program ${program.programId.toBase58()} but the address book ` +
        `is for ${book.programId}`
    );
  }

  // Warned rather than thrown: under systemd a throw here is a restart loop
  // over a setting that no longer does anything.
  if (process.env.KEEPER_WRAPPER) {
    log(
      "warn",
      "KEEPER_WRAPPER is ignored: every vault delivers its own first wrapper"
    );
  }

  const paymentMint = new PublicKey(book.payment.mint);
  const keeperPaymentAccount = getAssociatedTokenAddressSync(
    paymentMint,
    keeper.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );
  const contexts: Context[] = vaultsOf(book).map((vaultEntry) => {
    const wrapper = vaultEntry.wrappers[0];
    if (!wrapper) {
      throw new Error(`vault ${vaultEntry.symbol} has no wrappers`);
    }
    const wrapperMint = new PublicKey(wrapper.mint);
    return {
      connection,
      program,
      book,
      vaultEntry,
      quoteUsdcPerShare: optionalNumber(
        `KEEPER_QUOTE_${vaultEntry.symbol}`,
        QUOTE_USDC_PER_SHARE
      ),
      keeper,
      wrapper,
      wrapperMint,
      paymentMint,
      vault: new PublicKey(vaultEntry.address),
      receiptMint: new PublicKey(vaultEntry.receiptMint),
      wrapperPda: new PublicKey(wrapper.wrapper),
      vaultWrapperAccount: new PublicKey(wrapper.vaultTokenAccount),
      keeperPaymentAccount,
      keeperWrapperAccount: getAssociatedTokenAddressSync(
        wrapperMint,
        keeper.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      ),
    };
  });

  const activeOffset = offsetOfField(idl, "Schedule", "active");

  log("info", `keeper ${keeper.publicKey.toBase58()}`);
  log("info", `rpc ${RPC_URL}`);
  log("info", `program ${book.programId}`);
  for (const ctx of contexts) {
    log(
      "info",
      `vault ${ctx.vaultEntry.symbol} ${ctx.vault.toBase58()} delivering ` +
        `${ctx.wrapper.label} ${ctx.wrapper.mint} at ${ctx.quoteUsdcPerShare} per share`
    );
  }
  log(
    "info",
    `polling every ${POLL_SECONDS}s, active flag at byte ${activeOffset}`
  );

  const sol = await withRetry(
    "keeper balance",
    () => connection.getBalance(keeper.publicKey),
    retryOptions()
  );
  log("info", `balance ${sol / 1e9} SOL`);
  if (sol < 20_000_000) {
    log(
      "warn",
      "balance is low; executions pay rent for the escrow and receipt"
    );
  }

  // The keeper's own token accounts, created once at startup rather than
  // checked on every execution.
  await withRetry(
    "keeper token accounts",
    () => {
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(
          keeper.publicKey,
          keeperPaymentAccount,
          keeper.publicKey,
          paymentMint,
          TOKEN_PROGRAM_ID
        ),
        ...contexts.map((ctx) =>
          createAssociatedTokenAccountIdempotentInstruction(
            keeper.publicKey,
            ctx.keeperWrapperAccount,
            keeper.publicKey,
            ctx.wrapperMint,
            TOKEN_2022_PROGRAM_ID
          )
        )
      );
      tx.recentBlockhash = undefined;
      tx.lastValidBlockHeight = undefined;
      tx.signatures = [];
      return sendAndConfirmTransaction(connection, tx, [keeper]);
    },
    retryOptions({ idempotent: true })
  );

  while (!stopping) {
    try {
      await pollOnce(contexts, activeOffset);
    } catch (err) {
      // A poll that fails outright, usually the RPC being unreachable past
      // withRetry's attempts, is not fatal. Log it and try again next tick;
      // exiting would just make systemd restart into the same outage.
      log("error", `poll failed: ${describeError(err)}`);
    }
    await sleep(POLL_SECONDS);
  }

  log("info", "stopped");
}

main().catch((err) => {
  log("error", describeError(err));
  process.exit(1);
});
