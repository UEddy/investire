/**
 * Drives the app's own chain library against devnet, headlessly.
 *
 * The browser wallet cannot be clicked through from CI, so instead of testing
 * the UI this tests the thing underneath it: every function in src/lib/paritas
 * that the UI calls, in the order the UI calls it, signed by a local keypair
 * standing in for the wallet. If this passes, the only thing left untested
 * between here and a working app is the wallet adapter handing back a
 * signature.
 *
 *   ANCHOR_WALLET=~/.config/solana/id.json npm run verify
 */
import * as fs from "node:fs";
import { AnchorProvider, Idl, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ADDRESS_BOOK,
  ASSETS,
  MONTH_SECONDS,
  WEEK_SECONDS,
  assetBySymbol,
} from "../src/lib/config";
import {
  RUNS_FUNDED,
  buildCancelPlanTransaction,
  buildChangePlanTransaction,
  buildCreatePlanTransaction,
  buildWithdrawTransaction,
  loadExecutions,
  loadFunding,
  loadPayoutSources,
  planPayout,
  loadPlanLimits,
  planProblem,
  checkFundingBlock,
  getProgram,
  loadHoldings,
  loadPlans,
  ownerPaymentAccount,
  schedulePda,
} from "../src/lib/paritas";
import {
  cadencePhrase,
  formatMoney,
  formatMoneyShort,
  formatShares,
  whenNext,
} from "../src/lib/format";

/**
 * Mirrors the retry discipline in scripts/devnet-lib.ts rather than importing
 * it across package boundaries: only failures that provably did not execute
 * are retried. "Block height exceeded" is not among them, because it leaves it
 * unknown whether the transaction landed and a cancel or a create replayed on
 * that basis would be wrong.
 */
async function send(
  connection: Connection,
  what: string,
  transaction: Transaction,
  signer: Keypair,
): Promise<string> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      transaction.recentBlockhash = undefined;
      transaction.lastValidBlockHeight = undefined;
      transaction.signatures = [];
      return await sendAndConfirmTransaction(connection, transaction, [signer]);
    } catch (err) {
      const message = String(err);
      const didNotExecute =
        /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|502|503|504|429|Blockhash not found|Node is behind/i.test(
          message,
        );
      if (!didNotExecute || attempt === 5) {
        throw err;
      }
      console.log(`      retrying ${what}, attempt ${attempt + 1}/5`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw new Error("unreachable");
}

function fail(message: string): never {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

function ok(message: string): void {
  console.log(`ok    ${message}`);
}

/**
 * The endpoint to test against. The app's own copy of the address book has no
 * rpcUrl in it any more, on purpose, so this reads the unstripped original at
 * the repo root. RPC_URL overrides it.
 */
function endpoint(): string {
  if (process.env.RPC_URL) {
    return process.env.RPC_URL;
  }
  const root = JSON.parse(
    fs.readFileSync(new URL("../../devnet.json", import.meta.url), "utf8"),
  );
  return root.rpcUrl;
}

async function main(): Promise<void> {
  const RPC_URL = endpoint();
  const walletPath = process.env.ANCHOR_WALLET;
  if (!walletPath) {
    fail("ANCHOR_WALLET is not set");
  }
  const keypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))),
  );
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new Wallet(keypair);
  const program = getProgram(connection, wallet as AnchorProvider["wallet"]);
  const owner = keypair.publicKey;

  console.log(`saver   ${owner.toBase58()}`);
  console.log(`rpc     ${RPC_URL}`);
  console.log(`assets  ${ASSETS.map((asset) => asset.displayName).join(", ")}`);
  if (ASSETS.length !== 2) {
    fail(`expected two assets in the address book, found ${ASSETS.length}`);
  }
  console.log();

  // --- what the home screen reads ----------------------------------------
  let plans = await loadPlans(program, owner);
  ok(`loadPlans found ${plans.length} plan(s)`);

  const holdings = await loadHoldings(connection, owner, plans);
  const sharesLine = ASSETS.map(
    (asset) =>
      `${formatShares(holdings.shares[asset.symbol] ?? 0n, asset.receiptDecimals)} ${asset.displayName}`,
  ).join(", ");
  ok(
    `holdings: ${sharesLine}, ` +
      `${formatMoney(holdings.cash, ADDRESS_BOOK.payment.decimals)} to save with, ` +
      `${formatMoney(holdings.invested, ADDRESS_BOOK.payment.decimals)} invested`,
  );
  if (!holdings.hasPaymentAccount) {
    fail("the saver has no dollar account; the app would show its add funds state");
  }

  // --- buy history behind the streak --------------------------------------
  // The streak reads buy times off each plan's execution receipt address, on
  // the claim that its successful transactions are exactly that plan's buys.
  // The schedule keeps its own count, so the claim can be checked against it.
  const history = await loadExecutions(connection, plans);
  for (const plan of plans) {
    const found = history.filter((each) => each.plan === plan.address).length;
    if (found !== plan.executions) {
      fail(
        `plan ${plan.address} counts ${plan.executions} buys but history shows ${found}`,
      );
    }
  }
  ok(`buy history matches every plan's own count (${history.length} buys)`);

  // --- the constraint that shapes the create screen -----------------------
  const blockBefore = await checkFundingBlock(connection, owner, plans);
  console.log(`      funding block before: ${blockBefore.kind}`);

  const active = plans.filter((plan) => plan.active);
  if (active.length > 0 && blockBefore.kind !== "active-plan") {
    fail(
      `there are ${active.length} active plan(s) but checkFundingBlock did not block`,
    );
  }

  // Cancel anything live, so this run starts from the state a new saver is in
  // and exercises the create path for real.
  for (const plan of active) {
    const tx = await buildCancelPlanTransaction({
      program,
      owner,
      planAddress: schedulePda(owner, assetBySymbol(plan.asset), plan.index),
    });
    await send(connection, `cancel plan ${plan.index}`, tx, keypair);
    ok(`cancelled the existing plan at index ${plan.index}`);
  }

  plans = await loadPlans(program, owner);
  const clear = await checkFundingBlock(connection, owner, plans);
  if (clear.kind !== "none") {
    fail(`after cancelling, funding is still blocked: ${clear.kind}`);
  }
  ok("after cancelling, a new plan is not blocked");

  // --- three taps: amount, confirm ----------------------------------------
  const amount = 5_000_000n; // the $5 preset
  const { transaction, planAddress, index } = await buildCreatePlanTransaction({
    program,
    owner,
    amount,
    plans,
  });
  if (transaction.instructions.length !== 3) {
    fail(
      `create should be one transaction of 3 instructions, got ${transaction.instructions.length}`,
    );
  }
  ok("create plan is a single transaction, so a single wallet approval");

  await send(connection, "create plan", transaction, keypair);
  ok(`created plan ${planAddress.toBase58()} at index ${index}`);

  // --- what the home screen now says --------------------------------------
  plans = await loadPlans(program, owner);
  const created = plans.find((plan) => plan.address === planAddress.toBase58());
  if (!created) {
    fail("the new plan did not come back from loadPlans");
  }
  if (!created.active) {
    fail("the new plan is not active");
  }
  if (created.amount !== amount) {
    fail(`plan amount is ${created.amount}, expected ${amount}`);
  }
  if (created.cadenceSeconds !== WEEK_SECONDS) {
    fail(`plan cadence is ${created.cadenceSeconds}, expected weekly`);
  }

  const sentence =
    `You save ${formatMoneyShort(created.amount, ADDRESS_BOOK.payment.decimals)} ` +
    `${cadencePhrase(created.cadenceSeconds, created.nextDueTs)}. ` +
    `You own ${formatShares(holdings.shares[created.asset] ?? 0n, ASSETS[0].receiptDecimals)} ` +
    `shares of ${assetBySymbol(created.asset).displayName}.`;
  ok(`headline: "${sentence}"`);
  ok(`next run reads as "${whenNext(created.nextDueTs)}"`);

  // The delegation the keeper needs, and the block it now creates.
  const payment = await connection.getParsedAccountInfo(
    ownerPaymentAccount(owner),
    "confirmed",
  );
  const info = (payment.value?.data as any)?.parsed?.info;
  if (info?.delegate !== planAddress.toBase58()) {
    fail(`delegate is ${info?.delegate}, expected the new plan`);
  }
  ok(`dollar account delegates to the plan, allowance ${info.delegatedAmount.uiAmountString}`);

  const blockAfter = await checkFundingBlock(connection, owner, plans);
  if (blockAfter.kind !== "active-plan" || blockAfter.planAddress !== planAddress.toBase58()) {
    fail(`a second plan should be blocked by the first, got ${blockAfter.kind}`);
  }
  ok("a second plan is blocked, naming the plan holding the delegation");

  // --- validation before the wallet is asked ------------------------------
  const limits = await loadPlanLimits(program, ASSETS[0]);
  const tooSmall = planProblem({
    amount: limits.minAmount - 1n,
    cadenceSeconds: WEEK_SECONDS,
    limits,
    cash: 1n << 62n,
    moneyDecimals: ADDRESS_BOOK.payment.decimals,
  });
  if (!tooSmall) {
    fail("an amount one unit below the program's floor passed validation");
  }
  ok(`below the floor reads as "${tooSmall}"`);

  // --- change the plan: cancel plus recreate, one transaction -------------
  // Onto the second asset, so the change also proves a plan can move vaults.
  const spy = ASSETS[1];
  const changedAmount = 7_500_000n; // a typed amount, not a preset
  const change = await buildChangePlanTransaction({
    program,
    owner,
    plan: created,
    asset: spy,
    amount: changedAmount,
    cadenceSeconds: MONTH_SECONDS,
    plans,
  });
  if (change.transaction.instructions.length !== 4) {
    fail(
      `change should be one transaction of 4 instructions, got ${change.transaction.instructions.length}`,
    );
  }
  await send(connection, "change plan", change.transaction, keypair);
  ok(`changed plan to ${change.planAddress.toBase58()} at index ${change.index}`);

  plans = await loadPlans(program, owner);
  const old = plans.find((plan) => plan.address === planAddress.toBase58());
  const replacement = plans.find(
    (plan) => plan.address === change.planAddress.toBase58(),
  );
  if (!old || old.active) {
    fail("the replaced plan is still active");
  }
  if (!replacement?.active) {
    fail("the replacement plan is not active");
  }
  if (plans.filter((plan) => plan.active).length !== 1) {
    fail("more than one plan is active after a change");
  }
  if (
    replacement.amount !== changedAmount ||
    replacement.cadenceSeconds !== MONTH_SECONDS ||
    replacement.asset !== spy.symbol
  ) {
    fail("the replacement plan does not carry the new asset, amount and cadence");
  }
  if (replacement.nextDueTs > created.nextDueTs && created.nextDueTs > Date.now() / 1000) {
    fail("changing the plan pushed the next buy later than it was");
  }
  ok(`exactly one plan is active, now buying ${spy.displayName} with the new amount and cadence`);

  const funding = await loadFunding(connection, owner);
  if (funding.delegate !== change.planAddress.toBase58()) {
    fail(`delegate is ${funding.delegate}, expected the replacement plan`);
  }
  if (funding.delegatedAmount !== changedAmount * BigInt(RUNS_FUNDED)) {
    fail(
      `allowance is ${funding.delegatedAmount}, expected ${changedAmount * BigInt(RUNS_FUNDED)}`,
    );
  }
  ok(`the delegation moved to the replacement, allowing ${RUNS_FUNDED} buys and no more`);

  // --- taking shares out ---------------------------------------------------
  const nvda = ASSETS[0];
  const heldBefore = (await loadHoldings(connection, owner, plans)).shares[nvda.symbol] ?? 0n;
  if (heldBefore === 0n) {
    fail(`the saver holds no ${nvda.displayName} to test taking out with`);
  }
  const sources = await loadPayoutSources(connection, nvda);
  const available = sources.reduce((sum, source) => sum + source.vaultBalance, 0n);
  if (available === 0n) {
    fail("the vault holds nothing to pay a withdrawal from");
  }

  // Asking for more than every wrapper together holds must come back as a
  // plain answer, never as a transaction.
  const huge = planPayout(1n << 60n, sources);
  if (huge.kind !== "short") {
    fail("an impossible withdrawal was planned as if it could be paid");
  }
  ok("more than the vault holds is refused before any transaction");

  const takeOut = 100_000_000n; // 0.1 of a share
  const quoted = planPayout(takeOut, sources);
  if (quoted.kind !== "ok") {
    fail(`0.1 shares could not be planned: ${quoted.kind}`);
  }
  const withdrawal = await buildWithdrawTransaction({
    program,
    owner,
    asset: nvda,
    shares: takeOut,
  });

  // What actually lands in the wallet, per wrapper, against what the preview's
  // copy of the program's math said would. The preview is only worth showing
  // if these agree to the raw unit.
  const walletBalance = async (mint: string) => {
    try {
      const account = await getAccount(
        connection,
        getAssociatedTokenAddressSync(
          new PublicKey(mint),
          owner,
          false,
          TOKEN_2022_PROGRAM_ID,
        ),
        "confirmed",
        TOKEN_2022_PROGRAM_ID,
      );
      return account.amount;
    } catch {
      return 0n;
    }
  };
  const before = await Promise.all(
    quoted.legs.map((leg) => walletBalance(leg.source.wrapper.mint)),
  );
  await send(connection, "withdraw", withdrawal.transaction, keypair);
  const after = await Promise.all(
    quoted.legs.map((leg) => walletBalance(leg.source.wrapper.mint)),
  );
  quoted.legs.forEach((leg, i) => {
    if (after[i] - before[i] !== leg.rawOut) {
      fail(
        `wallet received ${after[i] - before[i]} raw units, the preview's math said ${leg.rawOut}`,
      );
    }
  });
  ok(`the wallet received exactly the raw amount the preview computed, over ${quoted.legs.length} leg(s)`);

  const heldAfter = (await loadHoldings(connection, owner, plans)).shares[nvda.symbol] ?? 0n;
  if (heldBefore - heldAfter !== takeOut) {
    fail(`savings fell by ${heldBefore - heldAfter}, expected ${takeOut}`);
  }
  ok(
    `took out ${formatShares(takeOut, nvda.receiptDecimals)} shares, ` +
      `${formatShares(withdrawal.received, nvda.receiptDecimals)} landed, ` +
      `preview said ${formatShares(quoted.received, nvda.receiptDecimals)}`,
  );
  if (withdrawal.received !== quoted.received) {
    fail("what landed differs from what the preview promised");
  }

  // --- the copy rule ------------------------------------------------------
  const forbidden = ["NVDAx", "NVDAon", "multiplier", "basis point", "wrapper"];
  for (const word of forbidden) {
    if (sentence.toLowerCase().includes(word.toLowerCase())) {
      fail(`the headline leaked "${word}"`);
    }
  }
  ok("no wrapper names, multipliers or basis points in the copy");

  console.log();
  console.log("Full flow verified against devnet.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
