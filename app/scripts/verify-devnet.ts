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
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { ADDRESS_BOOK, RPC_URL, WEEK_SECONDS } from "../src/lib/config";
import {
  buildCancelPlanTransaction,
  buildCreatePlanTransaction,
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

async function main(): Promise<void> {
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
  console.log(`vault   ${ADDRESS_BOOK.vault.displayName}`);
  console.log();

  // --- what the home screen reads ----------------------------------------
  let plans = await loadPlans(program, owner);
  ok(`loadPlans found ${plans.length} plan(s)`);

  const holdings = await loadHoldings(connection, owner, plans);
  ok(
    `holdings: ${formatShares(holdings.shares, ADDRESS_BOOK.vault.receiptDecimals)} shares, ` +
      `${formatMoney(holdings.cash, ADDRESS_BOOK.payment.decimals)} to save with, ` +
      `${formatMoney(holdings.invested, ADDRESS_BOOK.payment.decimals)} invested`,
  );
  if (!holdings.hasPaymentAccount) {
    fail("the saver has no dollar account; the app would show its add funds state");
  }

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
      planAddress: schedulePda(owner, plan.index),
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
    `You own ${formatShares(holdings.shares, ADDRESS_BOOK.vault.receiptDecimals)} ` +
    `shares of ${ADDRESS_BOOK.vault.displayName}.`;
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
