/**
 * Runs one full Investire schedule lifecycle on devnet, end to end.
 *
 *   create_schedule -> approve the delegation -> begin_execution, swap,
 *   settle_execution as a single transaction -> verify the result on chain
 *
 * Every address comes out of devnet.json. Run scripts/setup-devnet.ts first.
 *
 * The execution is submitted by a separate keeper keypair, not by the wallet
 * that owns the schedule. That is the whole claim being tested: an untrusted
 * third party assembles and pays for the transaction, the shares land with the
 * owner, and the keeper walks away with the fee and nothing else. Running it
 * from the owner's own key would prove none of that.
 *
 * Usage: npx ts-node --project tsconfig.scripts.json scripts/run-lifecycle.ts
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
  createApproveCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  REPO_ROOT,
  MAX_KEEPER_FEE_BPS,
  currentMultiplierFixed,
  formatAmount,
  keeperFee,
  loadAddressBook,
  toEquityUnits,
  withRetry,
} from "./devnet-lib";

/** Five dollars a week, the shape SPEC.md describes. */
const AMOUNT_USDC = 5_000_000n; // six decimals
const CADENCE_SECONDS = 7 * 24 * 60 * 60;

/**
 * How far below the previous execution's realised shares the next one may
 * land. Wide enough to absorb an ordinary week of movement in the underlying,
 * narrow enough that a keeper shorting the delivery is rejected.
 */
const FLOOR_TOLERANCE_BPS = 2_000; // 20%

/** Weeks of buys the owner delegates up front. */
const WEEKS_DELEGATED = 4n;

/** Raw wrapper units the substitute swap delivers. See buildSwapSubstitute. */
const DELIVERY_WHOLE_UNITS = 1n;

function pow10(exponent: number): bigint {
  let result = 1n;
  for (let i = 0; i < exponent; i++) {
    result *= 10n;
  }
  return result;
}

function keeperKeypairPath(): string {
  return path.join(REPO_ROOT, ".devnet-keys", "keeper.json");
}

function loadOrCreateKeypair(file: string): Keypair {
  if (fs.existsSync(file)) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")))
    );
  }
  const keypair = Keypair.generate();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Array.from(keypair.secretKey)));
  return keypair;
}

async function send(
  connection: Connection,
  what: string,
  transaction: Transaction,
  signers: Keypair[],
  idempotent = false
): Promise<string> {
  return withRetry(
    what,
    () => {
      transaction.recentBlockhash = undefined;
      transaction.lastValidBlockHeight = undefined;
      transaction.signatures = [];
      return sendAndConfirmTransaction(connection, transaction, signers);
    },
    { idempotent }
  );
}

async function tokenBalance(
  connection: Connection,
  address: PublicKey
): Promise<bigint> {
  const balance = await withRetry(`balance of ${address.toBase58()}`, () =>
    connection.getTokenAccountBalance(address)
  );
  return BigInt(balance.value.amount);
}

function heading(text: string): void {
  console.log();
  console.log(text);
  console.log("-".repeat(text.length));
}

async function main(): Promise<void> {
  const book = loadAddressBook();
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;

  const idl = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "target/idl/paritas.json"), "utf8")
  );
  const program = new Program(idl, provider) as Program<anchor.Idl>;

  const ownerWallet = (provider.wallet as anchor.Wallet).payer;
  const owner = ownerWallet.publicKey;
  if (owner.toBase58() !== book.owner.address) {
    throw new Error(
      `devnet.json was built for owner ${
        book.owner.address
      }, but the current wallet is ${owner.toBase58()}. ` +
        "Rerun scripts/setup-devnet.ts with this wallet."
    );
  }

  // The wrapper this run buys. Either registered wrapper would do, which is
  // rather the point: the schedule is denominated in equity units, not in a
  // particular issuer's token.
  const wrapper = book.wrappers[0];
  const wrapperMint = new PublicKey(wrapper.mint);
  const paymentMint = new PublicKey(book.payment.mint);
  const vault = new PublicKey(book.vault.address);
  const receiptMint = new PublicKey(book.vault.receiptMint);
  const ownerPaymentAccount = new PublicKey(book.owner.paymentAccount);
  const ownerReceiptAccount = new PublicKey(book.owner.receiptAccount);

  console.log("Investire schedule lifecycle on devnet");
  console.log(`  program        ${book.programId}`);
  console.log(`  vault          ${book.vault.symbol} ${book.vault.address}`);
  console.log(`  buying         ${wrapper.label} ${wrapper.mint}`);
  console.log(`  paying with    ${book.payment.label} ${book.payment.mint}`);
  console.log(`  owner          ${owner.toBase58()}`);

  const ownerUsdc = await tokenBalance(connection, ownerPaymentAccount);
  if (ownerUsdc < AMOUNT_USDC) {
    throw new Error(
      `the owner holds ${formatAmount(
        ownerUsdc,
        book.payment.decimals
      )} USDC, ` +
        `which is less than one ${formatAmount(
          AMOUNT_USDC,
          book.payment.decimals
        )} buy. ` +
        "Top up from faucet.circle.com."
    );
  }

  // --- the keeper ---------------------------------------------------------
  heading("Keeper");
  const keeper = loadOrCreateKeypair(keeperKeypairPath());
  console.log(`  keeper         ${keeper.publicKey.toBase58()}`);

  const keeperSol = await withRetry("keeper balance", () =>
    connection.getBalance(keeper.publicKey)
  );
  const KEEPER_SOL_FLOOR = 100_000_000; // 0.1 SOL, covers rent plus fees
  if (keeperSol < KEEPER_SOL_FLOOR) {
    await send(
      connection,
      "fund the keeper",
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: keeper.publicKey,
          lamports: KEEPER_SOL_FLOOR - keeperSol,
        })
      ),
      [ownerWallet]
    );
    console.log(`  funded         to ${KEEPER_SOL_FLOOR / 1e9} SOL`);
  } else {
    console.log(`  sol            ${keeperSol / 1e9}`);
  }

  const keeperPaymentAccount = getAssociatedTokenAddressSync(
    paymentMint,
    keeper.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );
  const keeperWrapperAccount = getAssociatedTokenAddressSync(
    wrapperMint,
    keeper.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  await send(
    connection,
    "keeper token accounts",
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        keeperPaymentAccount,
        keeper.publicKey,
        paymentMint,
        TOKEN_PROGRAM_ID
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        keeperWrapperAccount,
        keeper.publicKey,
        wrapperMint,
        TOKEN_2022_PROGRAM_ID
      )
    ),
    [ownerWallet],
    true
  );

  // Stock the keeper with the wrapper it will deliver. On mainnet the keeper
  // would acquire this inside the transaction by routing the USDC through
  // Jupiter; see buildSwapSubstitute for why that leg is faked here.
  const delivery = DELIVERY_WHOLE_UNITS * pow10(wrapper.decimals);
  const keeperWrapperHeld = await tokenBalance(
    connection,
    keeperWrapperAccount
  );
  if (keeperWrapperHeld < delivery) {
    await send(
      connection,
      "stock the keeper",
      new Transaction().add(
        createMintToInstruction(
          wrapperMint,
          keeperWrapperAccount,
          owner,
          delivery - keeperWrapperHeld,
          [],
          TOKEN_2022_PROGRAM_ID
        )
      ),
      [ownerWallet]
    );
  }
  console.log(
    `  inventory      ${formatAmount(
      await tokenBalance(connection, keeperWrapperAccount),
      wrapper.decimals
    )} ${wrapper.label}`
  );

  // --- create_schedule ----------------------------------------------------
  heading("create_schedule");

  // A fresh index every run. Reusing one would hit ScheduleNotDue, since the
  // previous run pushed next_due_ts a week out, and that is the schedule
  // working correctly rather than something to route around.
  let scheduleIndex = 0;
  let schedulePda: PublicKey | null = null;
  for (; scheduleIndex < 256; scheduleIndex++) {
    const [candidate] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(book.seeds.schedule),
        owner.toBuffer(),
        vault.toBuffer(),
        Buffer.from([scheduleIndex]),
      ],
      program.programId
    );
    const exists = await withRetry("probe schedule pda", () =>
      connection.getAccountInfo(candidate)
    );
    if (!exists) {
      schedulePda = candidate;
      break;
    }
  }
  if (!schedulePda) {
    throw new Error(
      "all 256 schedule indices for this owner and vault are in use"
    );
  }

  // What the delivery below is actually worth, computed the way the program
  // computes it, so the owner's floor is a real number rather than zero. The
  // caller's min_equity_units cannot protect the owner, since the caller picks
  // it; this is the value that binds.
  const now = Math.floor(Date.now() / 1000);
  const multFixed = currentMultiplierFixed(
    wrapper.mainnet.multiplier,
    wrapper.mainnet.newMultiplier,
    wrapper.mainnet.newMultiplierEffectiveTimestamp,
    now
  );
  const expectedEquityUnits = toEquityUnits(
    delivery,
    wrapper.decimals,
    multFixed
  );
  const initialFloor = (expectedEquityUnits * 9_000n) / 10_000n;

  console.log(`  index          ${scheduleIndex}`);
  console.log(`  schedule       ${schedulePda.toBase58()}`);
  console.log(
    `  amount         ${formatAmount(
      AMOUNT_USDC,
      book.payment.decimals
    )} USDC every ${CADENCE_SECONDS / 86_400} days`
  );
  console.log(
    `  initial floor  ${formatAmount(
      initialFloor,
      book.vault.receiptDecimals
    )} shares per run, tolerance ${FLOOR_TOLERANCE_BPS / 100}%`
  );

  await program.methods
    .createSchedule(
      scheduleIndex,
      new BN(AMOUNT_USDC.toString()),
      new BN(CADENCE_SECONDS),
      new BN(now),
      new BN(initialFloor.toString()),
      FLOOR_TOLERANCE_BPS
    )
    .accounts({
      owner,
      vault,
      paymentMint,
      ownerPaymentAccount,
      schedule: schedulePda,
      paymentTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("  created");

  // --- approve the delegation ---------------------------------------------
  heading("approve the delegation");

  // This is the only authority the program ever has over the owner's money,
  // and it is granted with a plain SPL approve that this program has no part
  // in. The owner caps their exposure by choosing the allowance and ends it
  // with revoke, neither of which needs the program's cooperation.
  //
  // Worth knowing: a token account carries exactly one delegate. Approving a
  // second schedule against this same USDC account replaces this delegation
  // rather than adding to it, so an owner running several schedules at once
  // needs a separate payment account per schedule. The Schedule pins
  // owner_payment_account precisely so that works.
  const allowance = AMOUNT_USDC * WEEKS_DELEGATED;
  await send(
    connection,
    "approve",
    new Transaction().add(
      createApproveCheckedInstruction(
        ownerPaymentAccount,
        paymentMint,
        schedulePda,
        owner,
        allowance,
        book.payment.decimals,
        [],
        TOKEN_PROGRAM_ID
      )
    ),
    [ownerWallet]
  );
  console.log(
    `  delegated      ${formatAmount(
      allowance,
      book.payment.decimals
    )} USDC to the schedule PDA (${WEEKS_DELEGATED} weeks)`
  );

  // --- the execution transaction ------------------------------------------
  heading("begin_execution, swap, settle_execution");

  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(book.seeds.executionEscrow), schedulePda.toBuffer()],
    program.programId
  );
  const [executionReceiptPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(book.seeds.executionReceipt), schedulePda.toBuffer()],
    program.programId
  );
  const wrapperPda = new PublicKey(wrapper.wrapper);
  const vaultWrapperAccount = new PublicKey(wrapper.vaultTokenAccount);

  const before = {
    ownerUsdc: await tokenBalance(connection, ownerPaymentAccount),
    ownerShares: await tokenBalance(connection, ownerReceiptAccount),
    keeperUsdc: await tokenBalance(connection, keeperPaymentAccount),
    keeperWrapper: await tokenBalance(connection, keeperWrapperAccount),
    vaultWrapper: await tokenBalance(connection, vaultWrapperAccount),
  };

  const beginIx = await program.methods
    .beginExecution()
    .accounts({
      caller: keeper.publicKey,
      schedule: schedulePda,
      vault,
      wrapper: wrapperPda,
      wrapperMint,
      paymentMint,
      owner,
      ownerPaymentAccount,
      callerPaymentAccount: keeperPaymentAccount,
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
  // mints that no venue has a market for, so there is no route to build.
  //
  // What stands in for it is a direct transfer of wrapper tokens the keeper
  // already holds, from the keeper's own account into the escrow. The keeper
  // keeps the USDC and gives up the shares, which is economically the same
  // position a keeper ends a real execution in after routing through Jupiter.
  //
  // What this substitution does NOT weaken is the part being tested. The
  // program never inspects this instruction. settle_execution measures the
  // escrow balance, values it at the live multiplier, and checks it against
  // the floor, and it would do exactly that whether the tokens arrived from
  // Jupiter, from another aggregator, or from the keeper's own inventory. The
  // only thing not exercised here is route quality, which the program cannot
  // see on mainnet either, and which is why the floor exists at all.
  //
  // To run this against a real route, replace this one instruction with the
  // Jupiter swap instruction, destination escrowPda, and change nothing else.
  const swapSubstituteIx = createTransferCheckedInstruction(
    keeperWrapperAccount,
    wrapperMint,
    escrowPda,
    keeper.publicKey,
    delivery,
    wrapper.decimals,
    [],
    TOKEN_2022_PROGRAM_ID
  );
  // =========================================================================

  const settleIx = await program.methods
    .settleExecution(new BN(expectedEquityUnits.toString()))
    .accounts({
      caller: keeper.publicKey,
      schedule: schedulePda,
      receipt: executionReceiptPda,
      vault,
      wrapper: wrapperPda,
      wrapperMint,
      escrow: escrowPda,
      vaultWrapperAccount,
      receiptMint,
      owner,
      ownerReceiptAccount,
      paymentMint,
      ownerPaymentAccount,
      callerPaymentAccount: keeperPaymentAccount,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      paymentTokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  // Introspection walks every instruction in the transaction and both
  // executions make several CPIs, so the default budget is not enough. A
  // ComputeBudget instruction is not a paritas instruction, so the scan
  // ignores it.
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    beginIx,
    swapSubstituteIx,
    settleIx,
  ];
  const beginIndex = instructions.indexOf(beginIx);
  const settleIndex = instructions.indexOf(settleIx);

  const execution = new Transaction().add(...instructions);
  execution.feePayer = keeper.publicKey;

  console.log("  [0] compute budget");
  console.log(
    `  [${beginIndex}] begin_execution   pulls the buy, withholds the fee`
  );
  console.log("  [2] transfer          DEVNET SUBSTITUTE for a Jupiter route");
  console.log(
    `  [${settleIndex}] settle_execution  verifies, credits the owner, pays the fee`
  );

  const signature = await send(connection, "execution", execution, [keeper]);
  console.log(`  signature      ${signature}`);

  // --- verify -------------------------------------------------------------
  heading("Result");

  const after = {
    ownerUsdc: await tokenBalance(connection, ownerPaymentAccount),
    ownerShares: await tokenBalance(connection, ownerReceiptAccount),
    keeperUsdc: await tokenBalance(connection, keeperPaymentAccount),
    keeperWrapper: await tokenBalance(connection, keeperWrapperAccount),
    vaultWrapper: await tokenBalance(connection, vaultWrapperAccount),
  };

  const sharesCredited = after.ownerShares - before.ownerShares;
  const usdcSpent = before.ownerUsdc - after.ownerUsdc;
  const keeperNetUsdc = after.keeperUsdc - before.keeperUsdc;
  const d = book.payment.decimals;
  const r = book.vault.receiptDecimals;

  // The keeper's USDC balance moves twice in this transaction and the two
  // movements mean completely different things: begin_execution hands over the
  // swap funding, settle_execution pays the fee. A before and after delta
  // conflates them into one number and makes a 5 USDC buy look like a 5 USDC
  // fee. Recover the two legs from the transaction itself instead, so what is
  // reported is what the chain did rather than what the net happens to be.
  const parsed = await withRetry("fetch the execution transaction", () =>
    connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      // The Anchor provider's connection defaults to `processed`, and this
      // method will not serve anything below `confirmed`.
      commitment: "confirmed",
    })
  );
  if (!parsed?.meta?.innerInstructions) {
    throw new Error("could not read the execution transaction back");
  }

  function usdcLegsOf(outerIndex: number): bigint[] {
    const legs: bigint[] = [];
    for (const inner of parsed!.meta!.innerInstructions!) {
      if (inner.index !== outerIndex) {
        continue;
      }
      for (const ix of inner.instructions) {
        const parsedIx = (ix as any).parsed;
        if (
          parsedIx?.type === "transferChecked" &&
          parsedIx.info?.mint === book.payment.mint
        ) {
          legs.push(BigInt(parsedIx.info.tokenAmount.amount));
        }
      }
    }
    return legs;
  }

  const beginLegs = usdcLegsOf(beginIndex);
  const settleLegs = usdcLegsOf(settleIndex);
  const swapFunding = beginLegs.reduce((a, b) => a + b, 0n);
  const feePaid = settleLegs.reduce((a, b) => a + b, 0n);

  const expectedFee = keeperFee(
    AMOUNT_USDC,
    BigInt(book.vault.keeperFeeBps),
    BigInt(book.vault.keeperFeeMin)
  );
  const feeCeiling = (AMOUNT_USDC * MAX_KEEPER_FEE_BPS) / 10_000n;

  const schedule = (await withRetry("fetch schedule", () =>
    (program.account as any).schedule.fetch(schedulePda)
  )) as {
    executions: BN;
    nextDueTs: BN;
    minEquityUnits: BN;
    initialMinEquityUnits: BN;
    totalUsdcSpent: BN;
    totalEquityUnits: BN;
  };

  console.log(`  owner paid       ${formatAmount(usdcSpent, d)} USDC`);
  console.log(
    `  owner received   ${formatAmount(sharesCredited, r)} shares of ${
      book.vault.symbol
    }`
  );
  console.log();
  console.log("  where the owner's USDC went:");
  console.log(
    `    swap funding   ${formatAmount(
      swapFunding,
      d
    )} USDC to the keeper to buy with`
  );
  console.log(
    `    keeper fee     ${formatAmount(
      feePaid,
      d
    )} USDC, the keeper's actual earnings`
  );
  console.log(
    `                   (${book.vault.keeperFeeBps} bps would be ${formatAmount(
      (AMOUNT_USDC * BigInt(book.vault.keeperFeeBps)) / 10_000n,
      d
    )}, ` +
      `minimum is ${formatAmount(BigInt(book.vault.keeperFeeMin), d)}, ` +
      `cap is ${formatAmount(feeCeiling, d)})`
  );
  console.log();
  console.log(
    `  keeper net USDC  ${formatAmount(
      keeperNetUsdc,
      d
    )} (fee plus the unspent swap funding)`
  );
  console.log(
    `  keeper gave up   ${formatAmount(
      before.keeperWrapper - after.keeperWrapper,
      wrapper.decimals
    )} ${wrapper.label} from inventory`
  );
  console.log(
    "                   On mainnet the funding would have been spent at Jupiter"
  );
  console.log(
    "                   instead; the devnet substitute delivers from inventory,"
  );
  console.log("                   so the keeper keeps it and gives up shares.");
  console.log();
  console.log(
    `  vault holds      ${formatAmount(after.vaultWrapper, wrapper.decimals)} ${
      wrapper.label
    } (up ${formatAmount(
      after.vaultWrapper - before.vaultWrapper,
      wrapper.decimals
    )})`
  );
  console.log(`  executions       ${schedule.executions.toString()}`);
  console.log(
    `  next due         ${new Date(
      schedule.nextDueTs.toNumber() * 1000
    ).toISOString()}`
  );
  console.log(
    `  floor ratchet    ${formatAmount(
      BigInt(schedule.initialMinEquityUnits.toString()),
      r
    )} -> ${formatAmount(BigInt(schedule.minEquityUnits.toString()), r)}`
  );

  const failures: string[] = [];
  if (sharesCredited !== expectedEquityUnits) {
    failures.push(
      `owner was credited ${sharesCredited} equity units, expected ${expectedEquityUnits}`
    );
  }
  if (usdcSpent !== AMOUNT_USDC) {
    failures.push(`owner paid ${usdcSpent}, expected ${AMOUNT_USDC}`);
  }

  // The fee checks, read off the chain rather than off a balance delta.
  if (feePaid !== expectedFee) {
    failures.push(
      `settle_execution paid a fee of ${feePaid}, expected ${expectedFee}`
    );
  }
  if (feePaid > feeCeiling) {
    failures.push(
      `fee ${feePaid} exceeds MAX_KEEPER_FEE_BPS of the buy (${feeCeiling})`
    );
  }
  if (swapFunding !== AMOUNT_USDC - expectedFee) {
    failures.push(
      `begin_execution moved ${swapFunding} as swap funding, expected ${
        AMOUNT_USDC - expectedFee
      }`
    );
  }
  if (swapFunding + feePaid !== AMOUNT_USDC) {
    failures.push(
      `the two legs sum to ${
        swapFunding + feePaid
      }, not the ${AMOUNT_USDC} debited`
    );
  }
  if (keeperNetUsdc !== AMOUNT_USDC) {
    failures.push(
      `keeper net USDC is ${keeperNetUsdc}; with the swap faked from inventory it should be the full ${AMOUNT_USDC}`
    );
  }

  if (after.vaultWrapper - before.vaultWrapper !== delivery) {
    failures.push("the vault did not receive the delivery");
  }
  if (schedule.executions.toNumber() !== 1) {
    failures.push(`executions is ${schedule.executions}, expected 1`);
  }
  // The escrow and the execution receipt exist for one transaction only.
  for (const [label, address] of [
    ["escrow", escrowPda],
    ["execution receipt", executionReceiptPda],
  ] as const) {
    const info = await withRetry(`check ${label} closed`, () =>
      connection.getAccountInfo(address)
    );
    if (info !== null) {
      failures.push(`${label} was not closed`);
    }
  }
  const expectedRatchet =
    (expectedEquityUnits * BigInt(10_000 - FLOOR_TOLERANCE_BPS)) / 10_000n;
  if (BigInt(schedule.minEquityUnits.toString()) !== expectedRatchet) {
    failures.push(
      `floor ratcheted to ${schedule.minEquityUnits}, expected ${expectedRatchet}`
    );
  }

  console.log();
  if (failures.length > 0) {
    console.error("FAILED:");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
  console.log(
    "All checks passed. The shares went to the owner, not the caller."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
