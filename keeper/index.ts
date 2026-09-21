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
 *   KEEPER_POLL_SECONDS         default 60, ignored with --once
 *   KEEPER_ONCE                 set to run a single pass, same as --once
 *   KEEPER_COMPUTE_UNIT_LIMIT   default 400000
 *   KEEPER_CONFIRM_TIMEOUT_SECONDS default 60, see sendAndConfirm
 *   KEEPER_PRICE_SOURCE         "flat" (default) or "pyth"
 *   KEEPER_QUOTE_USDC_PER_SHARE default 5, the flat price
 *   PYTH_API_KEY                required when the source is pyth
 *   PYTH_HERMES_URL             default https://pyth.dourolabs.app/hermes
 *   KEEPER_MAX_PRICE_AGE_SECONDS default 60, pyth only, see priceProblem
 *   KEEPER_MAX_CONFIDENCE_PERCENT default 1, pyth only, see priceProblem
 *
 * Two modes. By default it polls forever, which is what a long lived process
 * under systemd wants. With --once, or KEEPER_ONCE set, it makes one pass over
 * everything due and exits, which is what a scheduled CI job wants: the
 * schedule lives in cron rather than in this process, and nothing has to stay
 * up between runs.
 *
 * Every vault in the address book is served. Each delivers its own first
 * wrapper, which is the one setup-devnet.ts stocks the keeper with, at the
 * Pyth price of the vault's underlying.
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
  Signer,
  SystemProgram,
  Transaction,
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
  PythQuote,
  RetryOptions,
  VaultEntry,
  WrapperEntry,
  vaultsOf,
  currentMultiplierFixed,
  fetchPythQuotes,
  formatAmount,
  fromEquityUnits,
  keeperFee,
  paymentPerShare,
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

/**
 * One pass, then exit. The distinction that matters for a scheduled run is
 * between "nothing was due", which is the ordinary case and a success, and a
 * failure to find out, which is not. See main.
 */
const RUN_ONCE =
  process.argv.includes("--once") || Boolean(process.env.KEEPER_ONCE);
const COMPUTE_UNIT_LIMIT = optionalNumber("KEEPER_COMPUTE_UNIT_LIMIT", 400_000);
/**
 * Where delivery prices come from. Pyth is integrated and tested against a
 * stand-in Hermes, but the project's key is not yet accepted (Hermes answers
 * 403), so the default is a flat price per share until it is. Switching is
 * KEEPER_PRICE_SOURCE=pyth plus PYTH_API_KEY; nothing else changes.
 */
const PRICE_SOURCE = process.env.KEEPER_PRICE_SOURCE ?? "flat";
if (PRICE_SOURCE !== "flat" && PRICE_SOURCE !== "pyth") {
  throw new Error(`KEEPER_PRICE_SOURCE must be flat or pyth, got ${PRICE_SOURCE}`);
}
const PYTH_API_KEY = PRICE_SOURCE === "pyth" ? required("PYTH_API_KEY") : "";
const FLAT_USDC_PER_SHARE = optionalNumber("KEEPER_QUOTE_USDC_PER_SHARE", 5);
const PYTH_HERMES_URL =
  process.env.PYTH_HERMES_URL ?? "https://pyth.dourolabs.app/hermes";
const MAX_PRICE_AGE_SECONDS = optionalNumber("KEEPER_MAX_PRICE_AGE_SECONDS", 60);
const MAX_CONFIDENCE_PERCENT = optionalNumber("KEEPER_MAX_CONFIDENCE_PERCENT", 1);
const CONFIRM_TIMEOUT_SECONDS = optionalNumber("KEEPER_CONFIRM_TIMEOUT_SECONDS", 60);

// --- logging ---------------------------------------------------------------

/**
 * One line per event, timestamped, no log library. journalctl adds everything
 * else worth having, and a 512MB droplet does not need a logging framework to
 * print a sentence.
 */
/**
 * An RPC endpoint reduced to its origin, for logging.
 *
 * Paid endpoints carry the API key in the url, in the path for some providers
 * and in the query for others, so the whole url is a credential and printing
 * it leaks one. This keeps the part that identifies which provider is in use,
 * which is the only part worth logging, and drops everything that could
 * authenticate as us. Under CI the endpoint is a repository secret and the
 * runner would usually mask it, but that masking is a backstop and not a
 * reason to print a secret in the first place.
 */
function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : "/..."}`;
  } catch {
    return "(unparseable url)";
  }
}

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

// --- sending ---------------------------------------------------------------

/**
 * Signs, sends and confirms a transaction over plain HTTP, and gives up after
 * a bounded wait.
 *
 * sendAndConfirmTransaction confirms by subscribing over a websocket. On the
 * public devnet endpoint that subscription can be refused with a 429, and
 * when it is, the confirmation promise simply never settles: the keeper sat
 * silent for minutes on its startup transaction while that transaction had
 * landed in three seconds. The app hit the same thing through its HTTP only
 * RPC proxy and polls getSignatureStatuses instead; this is the same fix.
 *
 * Every wait ends. Confirmed, the signature comes back. Failed on chain, the
 * chain's error is thrown. Out of time, or past the blockhash's last valid
 * height, it throws a "was not confirmed" error, which withRetry classifies
 * as outcome unknown: retried for idempotent sends, reported and left alone
 * for an execution, whose next_due_ts the next poll re-reads to learn what
 * actually happened. A transient failure of a status poll is not an answer,
 * so it is waited through rather than thrown.
 */
async function sendAndConfirm(
  connection: Connection,
  transaction: Transaction,
  signers: Signer[],
  timeoutSeconds = CONFIRM_TIMEOUT_SECONDS
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.signatures = [];
  transaction.sign(...signers);

  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    { preflightCommitment: "confirmed" }
  );

  const deadline = Date.now() + timeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    try {
      const { value } = await connection.getSignatureStatuses([signature]);
      const status = value[0];
      if (status?.err) {
        throw new ChainError(signature, status.err);
      }
      if (
        status?.confirmationStatus === "confirmed" ||
        status?.confirmationStatus === "finalized"
      ) {
        return signature;
      }
      if (!status) {
        const height = await connection.getBlockHeight("confirmed");
        if (height > lastValidBlockHeight) {
          throw new Error(
            `transaction ${signature} was not confirmed: block height exceeded`
          );
        }
      }
    } catch (err) {
      if (err instanceof ChainError || /was not confirmed/.test(String(err))) {
        throw err;
      }
      // A 429 or a dropped connection on a status poll says nothing about the
      // transaction. Keep waiting until the deadline.
    }
  }
  throw new Error(
    `transaction ${signature} was not confirmed within ${timeoutSeconds}s`
  );
}

/** The chain's own verdict on a transaction that landed and failed. */
class ChainError extends Error {
  constructor(readonly signature: string, readonly detail: unknown) {
    super(`transaction ${signature} failed on chain: ${JSON.stringify(detail)}`);
    this.name = "ChainError";
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
 * Why a price should not be traded on, or null if it can be.
 *
 * STALE PRICES ARE SKIPPED, NOT USED. The feeds are US equities and stop at
 * the close, so outside market hours the latest price is hours or days old.
 * Buying at it would hand the saver a number of shares worked out from
 * Friday's close on a Sunday: exactly the quietly wrong scheduled buy this
 * project exists to prevent, and on mainnet the Jupiter route would fill at
 * whatever the wrapper actually trades at, not at that number. So the run is
 * left due and retried on every poll until the price is live again.
 *
 * What skipping costs is timing, not money. A plan due on Saturday buys at
 * Monday's open. It does not buy twice to catch up: settle_execution's
 * next_due_after moves the next due date a full cadence past the late buy,
 * so a daily plan loses its weekend buys rather than bunching them.
 *
 * A price whose confidence interval is wide against the price, as it can be
 * right at the open, is skipped for the same reason.
 */
function priceProblem(quote: PythQuote | undefined, now: number): string | null {
  if (!quote) {
    return "no price for this asset";
  }
  const age = now - quote.publishTime;
  if (age > MAX_PRICE_AGE_SECONDS) {
    return `price is ${formatAge(age)} old, market likely closed; leaving it due`;
  }
  // conf / price > percent / 100, in integers.
  if (quote.conf * 10_000n > quote.price * BigInt(Math.round(MAX_CONFIDENCE_PERCENT * 100))) {
    return "price confidence is too wide right now; leaving it due";
  }
  return null;
}

/**
 * The flat price as a quote in Pyth's shape, published now, so a flat run goes
 * through exactly the same delivery arithmetic as a Pyth one and passes the
 * liveness check by construction. The mantissa is at the payment decimals.
 */
function flatQuotes(feedIds: string[], paymentDecimals: number): Record<string, PythQuote> {
  const price = BigInt(Math.round(FLAT_USDC_PER_SHARE * Number(pow10(paymentDecimals))));
  const now = Math.floor(Date.now() / 1000);
  return Object.fromEntries(
    feedIds.map((id) => [id, { price, conf: 0n, expo: -paymentDecimals, publishTime: now }])
  );
}

function formatAge(seconds: number): string {
  if (seconds < 120) {
    return `${seconds}s`;
  }
  if (seconds < 2 * 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  if (seconds < 2 * 86400) {
    return `${Math.round(seconds / 3600)}h`;
  }
  return `${Math.round(seconds / 86400)}d`;
}

/**
 * How many raw wrapper units this execution should deliver, at a Pyth price.
 *
 * The keeper is paid its fee out of the buy, so what the saver's shares are
 * bought with is the amount less that fee, the same swap amount
 * begin_execution hands over. That buys swapAmount / price shares of the
 * underlying, and the wrapper amount carrying exactly that many shares comes
 * from the wrapper's own multiplier, the inverse of what settle_execution
 * will apply when it values the delivery. Rounded down at every step.
 */
function quoteDelivery(
  swapAmount: bigint,
  quote: PythQuote,
  paymentDecimals: number,
  wrapper: WrapperEntry,
  multFixed: bigint,
  equityDecimals: number
): { delivery: bigint; shares: bigint; perShare: bigint } {
  const perShare = paymentPerShare(quote, paymentDecimals);
  const shares = (swapAmount * pow10(equityDecimals)) / perShare;
  return {
    delivery: fromEquityUnits(shares, wrapper.decimals, multFixed),
    shares,
    perShare,
  };
}

// --- one execution ---------------------------------------------------------

interface Context {
  connection: Connection;
  program: Program<anchor.Idl>;
  book: AddressBook;
  /** The vault this context executes for. One context per vault. */
  vaultEntry: VaultEntry;
  /** The Pyth feed for this vault's underlying, id without 0x. */
  priceFeedId: string;
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

/**
 * Runs one due schedule. Returns true when an execution actually landed, and
 * false when the schedule was passed over for a reason that is nobody's fault
 * and will still be true or not next time: an unusable price, a buy too small
 * to round to any shares, an owner who cannot currently pay. Skips are not
 * failures and are not counted as executions either, which matters for the
 * summary a scheduled run prints.
 */
async function execute(
  ctx: Context,
  schedulePda: PublicKey,
  schedule: ScheduleAccount,
  quote: PythQuote | undefined
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const unusable = priceProblem(quote, now);
  if (unusable || !quote) {
    log("warn", `skip ${schedulePda.toBase58()}: ${unusable}`);
    return false;
  }

  const amount = BigInt(schedule.amountUsdc.toString());
  const swapAmount =
    amount -
    keeperFee(
      amount,
      BigInt(ctx.vaultEntry.keeperFeeBps),
      BigInt(ctx.vaultEntry.keeperFeeMin)
    );
  const multFixed = currentMultiplierFixed(
    ctx.wrapper.mainnet.multiplier,
    ctx.wrapper.mainnet.newMultiplier,
    ctx.wrapper.mainnet.newMultiplierEffectiveTimestamp,
    now
  );
  const { delivery, perShare } = quoteDelivery(
    swapAmount,
    quote,
    ctx.book.payment.decimals,
    ctx.wrapper,
    multFixed,
    ctx.vaultEntry.receiptDecimals
  );
  if (delivery === 0n) {
    log("warn", `skip ${schedulePda.toBase58()}: buy rounds to no shares`);
    return false;
  }
  const expectedEquityUnits = toEquityUnits(
    delivery,
    ctx.wrapper.decimals,
    multFixed
  );

  const blocked = await preflight(ctx, schedule, delivery, expectedEquityUnits);
  if (blocked) {
    log("warn", `skip ${schedulePda.toBase58()}: ${blocked}`);
    return false;
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
  // THIS IS NOT A SWAP. It is inventory delivered at a Pyth-quoted rate.
  //
  // On mainnet this one instruction is a Jupiter route that sells the USDC
  // begin_execution just handed the keeper and delivers the wrapper into the
  // escrow. Jupiter is not deployed on devnet, and these are mock mints no
  // venue makes a market in, so there is no route to build.
  //
  // What stands in for it is a direct transfer out of the keeper's own wrapper
  // inventory into the escrow, sized by quoteDelivery from the price source:
  // a flat price per share by default, or with KEEPER_PRICE_SOURCE=pyth the
  // Pyth price of the underlying (Equity.US.NVDA/USD, Equity.US.SPY/USD) at
  // the moment of the run, and only while that price is live. The keeper keeps the USDC and gives
  // up the shares, the position a keeper ends a real execution in anyway, and
  // the saver's cost basis is what the shares actually cost at the time.
  //
  // The program never inspects this instruction. settle_execution measures the
  // escrow balance, values it at the live multiplier and checks it against the
  // floor, and would do exactly that whether the tokens came from Jupiter,
  // another aggregator, or inventory. To go to mainnet, a Jupiter route with
  // destination escrowPda replaces this one instruction and nothing else.
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
    () => sendAndConfirm(ctx.connection, transaction, [ctx.keeper]),
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
      `price=${formatAmount(perShare, ctx.book.payment.decimals)} ` +
      `priceAge=${formatAge(now - quote.publishTime)} ` +
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

  return true;
}

// --- the poll loop ---------------------------------------------------------

/**
 * What one pass did. Returned rather than logged alone because --once turns
 * this into the run's exit status, and "nothing was due" has to be tellable
 * from "could not find out what was due".
 */
interface PassResult {
  due: number;
  executed: number;
  skipped: number;
  failed: number;
  /** Set when prices could not be read, which leaves everything due. */
  pricesUnavailable: boolean;
}

async function pollOnce(
  contexts: Context[],
  activeOffset: number
): Promise<PassResult> {
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
    return { due: 0, executed: 0, skipped: 0, failed: 0, pricesUnavailable: false };
  }
  log("info", `${due.length} schedule(s) due`);

  // One price read per poll, for every vault with something due. A read that
  // fails leaves every schedule due for the next poll, which is the same
  // answer a stale price gets, for the same reason.
  const feeds = Array.from(
    new Set(
      due.map((entry) => byVault.get(entry.account.vault.toBase58())!.priceFeedId)
    )
  );
  let quotes: Record<string, PythQuote>;
  try {
    quotes =
      PRICE_SOURCE === "pyth"
        ? await withRetry(
            "pyth prices",
            () => fetchPythQuotes(PYTH_HERMES_URL, PYTH_API_KEY, feeds),
            retryOptions()
          )
        : flatQuotes(feeds, first.book.payment.decimals);
  } catch (err) {
    log("warn", `prices unavailable (${describeError(err)}), leaving ${due.length} due`);
    return {
      due: due.length,
      executed: 0,
      skipped: 0,
      failed: 0,
      pricesUnavailable: true,
    };
  }

  let executed = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of due) {
    if (stopping) {
      log("info", "stopping, leaving the rest for the next run");
      break;
    }
    const ctx = byVault.get(entry.account.vault.toBase58())!;
    try {
      if (await execute(ctx, entry.publicKey, entry.account, quotes[ctx.priceFeedId])) {
        executed++;
      } else {
        skipped++;
      }
    } catch (err) {
      failed++;
      // One schedule's problem is its own. A revoked delegation, an owner who
      // spent their balance, a slot where the swap leg reverts: none of it is
      // a reason to stop serving everybody else.
      log(
        "error",
        `failed ${entry.publicKey.toBase58()}: ${describeError(err)}`
      );
    }
  }

  return { due: due.length, executed, skipped, failed, pricesUnavailable: false };
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
    if (!vaultEntry.priceFeed) {
      throw new Error(
        `vault ${vaultEntry.symbol} has no price feed in the address book; ` +
          "rerun scripts/setup-devnet.ts"
      );
    }
    const wrapperMint = new PublicKey(wrapper.mint);
    return {
      connection,
      program,
      book,
      vaultEntry,
      priceFeedId: vaultEntry.priceFeed.id.replace(/^0x/, "").toLowerCase(),
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
  log("info", `rpc ${redactUrl(RPC_URL)}`);
  log("info", `program ${book.programId}`);
  for (const ctx of contexts) {
    log(
      "info",
      `vault ${ctx.vaultEntry.symbol} ${ctx.vault.toBase58()} delivering ` +
        `${ctx.wrapper.label} ${ctx.wrapper.mint} priced by ${ctx.vaultEntry.priceFeed!.symbol}`
    );
  }
  log(
    "info",
    RUN_ONCE
      ? `single pass, active flag at byte ${activeOffset}`
      : `polling every ${POLL_SECONDS}s, active flag at byte ${activeOffset}`
  );
  log(
    "info",
    PRICE_SOURCE === "pyth"
      ? "pricing deliveries from Pyth; stale prices are skipped"
      : `pricing deliveries at a flat ${FLAT_USDC_PER_SHARE} per share`
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

  // The keeper's own token accounts. Idempotent, but a transaction that
  // creates nothing still costs a fee and a confirmation wait, and under
  // --once this runs on every scheduled invocation rather than once per boot.
  // So the accounts are read first and the transaction is only sent when one
  // is actually missing, which after the first run is never.
  const wanted = [
    {
      address: keeperPaymentAccount,
      mint: paymentMint,
      program: TOKEN_PROGRAM_ID,
    },
    ...contexts.map((ctx) => ({
      address: ctx.keeperWrapperAccount,
      mint: ctx.wrapperMint,
      program: TOKEN_2022_PROGRAM_ID,
    })),
  ];

  const missing = await withRetry(
    "keeper token accounts",
    async () => {
      const infos = await connection.getMultipleAccountsInfo(
        wanted.map((entry) => entry.address)
      );
      return wanted.filter((_, index) => infos[index] === null);
    },
    retryOptions()
  );

  if (missing.length > 0) {
    log("info", `creating ${missing.length} keeper token account(s)`);
    await withRetry(
      "create keeper token accounts",
      () => {
        const tx = new Transaction().add(
          ...missing.map((entry) =>
            createAssociatedTokenAccountIdempotentInstruction(
              keeper.publicKey,
              entry.address,
              keeper.publicKey,
              entry.mint,
              entry.program
            )
          )
        );
        return sendAndConfirm(connection, tx, [keeper]);
      },
      retryOptions({ idempotent: true })
    );
  }

  if (RUN_ONCE) {
    // Deliberately not wrapped. A pass that cannot even read the schedules is
    // the one thing a scheduled run must fail on, so the throw propagates to
    // main's catch and becomes a non-zero exit. Everything short of that is a
    // successful run, including the ordinary case of nothing being due.
    const result = await pollOnce(contexts, activeOffset);

    if (result.pricesUnavailable) {
      // Transient by nature, and it leaves every schedule due, so the next run
      // in five minutes picks them up. Reported as a warning rather than a
      // failure, since a red run here would mean a red run for every price
      // outage, however brief.
      log("warn", `prices unavailable, ${result.due} left due for the next run`);
    } else if (result.due === 0) {
      log("info", "nothing due");
    } else {
      log(
        "info",
        `${result.executed} executed, ${result.skipped} skipped, ` +
          `${result.failed} failed of ${result.due} due`
      );
    }

    // Note what this does not do: a schedule that failed on its own terms, an
    // owner who revoked the delegation or spent their balance, does not fail
    // the run. Those are expected and self correcting, and a job that went red
    // for one of them would be red until that owner acted, which teaches
    // everyone to ignore it. They are counted and logged above instead.
    return;
  }

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
