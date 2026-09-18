/**
 * Everything this app does on chain.
 *
 * Kept free of React so the same code can be driven headlessly by
 * scripts/verify-devnet.ts, which is how the flow gets tested against devnet
 * without a browser wallet in the loop. The UI layer holds no chain logic of
 * its own.
 */
import { AnchorProvider, BN, Idl, Program } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createApproveCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createRevokeInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ADDRESS_BOOK, PARITAS_IDL, WEEK_SECONDS } from "./config";

const book = ADDRESS_BOOK;

export const PROGRAM_ID = new PublicKey(book.programId);
export const VAULT = new PublicKey(book.vault.address);
export const RECEIPT_MINT = new PublicKey(book.vault.receiptMint);
export const PAYMENT_MINT = new PublicKey(book.payment.mint);

/** Weeks of buys a new plan is funded for up front. */
export const WEEKS_FUNDED = 12;

export function getProgram(
  connection: Connection,
  wallet: AnchorProvider["wallet"],
): Program<Idl> {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return new Program(PARITAS_IDL as Idl, provider) as Program<Idl>;
}

/**
 * Seeds as bytes, without touching the Buffer global. Node has it, browsers do
 * not, and Next does not polyfill it. TextEncoder is in both and says exactly
 * what is meant: these seeds are utf8 strings.
 */
const utf8 = new TextEncoder();

export function schedulePda(owner: PublicKey, index: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      utf8.encode(book.seeds.schedule),
      owner.toBytes(),
      VAULT.toBytes(),
      new Uint8Array([index]),
    ],
    PROGRAM_ID,
  )[0];
}

export function ownerPaymentAccount(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    PAYMENT_MINT,
    owner,
    false,
    TOKEN_PROGRAM_ID,
  );
}

export function ownerReceiptAccount(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    RECEIPT_MINT,
    owner,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
}

export interface Plan {
  address: string;
  index: number;
  amount: bigint;
  cadenceSeconds: number;
  nextDueTs: number;
  executions: number;
  investedTotal: bigint;
  sharesTotal: bigint;
  active: boolean;
}

interface RawSchedule {
  owner: PublicKey;
  vault: PublicKey;
  ownerPaymentAccount: PublicKey;
  scheduleIndex: number;
  amountUsdc: BN;
  cadenceSeconds: BN;
  nextDueTs: BN;
  executions: BN;
  totalUsdcSpent: BN;
  totalEquityUnits: BN;
  active: boolean;
}

/** Every plan this owner has on this vault, newest index last. */
export async function loadPlans(
  program: Program<Idl>,
  owner: PublicKey,
): Promise<Plan[]> {
  const accounts = await (program.account as any).schedule.all([
    { memcmp: { offset: 8, bytes: owner.toBase58() } },
  ]);

  return (accounts as { publicKey: PublicKey; account: RawSchedule }[])
    .filter((entry) => entry.account.vault.equals(VAULT))
    .map((entry) => ({
      address: entry.publicKey.toBase58(),
      index: entry.account.scheduleIndex,
      amount: BigInt(entry.account.amountUsdc.toString()),
      cadenceSeconds: entry.account.cadenceSeconds.toNumber(),
      nextDueTs: entry.account.nextDueTs.toNumber(),
      executions: entry.account.executions.toNumber(),
      investedTotal: BigInt(entry.account.totalUsdcSpent.toString()),
      sharesTotal: BigInt(entry.account.totalEquityUnits.toString()),
      active: entry.account.active,
    }))
    .sort((a, b) => a.index - b.index);
}

export interface Holdings {
  /** Shares actually held, read off the receipt token account. */
  shares: bigint;
  /** Dollars available to save with. */
  cash: bigint;
  /** Dollars put in across every plan, live or cancelled. */
  invested: bigint;
  hasPaymentAccount: boolean;
}

export async function loadHoldings(
  connection: Connection,
  owner: PublicKey,
  plans: Plan[],
): Promise<Holdings> {
  let shares = 0n;
  let cash = 0n;
  let hasPaymentAccount = false;

  try {
    const receipt = await getAccount(
      connection,
      ownerReceiptAccount(owner),
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    shares = receipt.amount;
  } catch {
    // No receipt account yet means no shares yet, which is the correct answer
    // for somebody who has not bought anything.
  }

  try {
    const payment = await getAccount(
      connection,
      ownerPaymentAccount(owner),
      "confirmed",
      TOKEN_PROGRAM_ID,
    );
    cash = payment.amount;
    hasPaymentAccount = true;
  } catch {
    hasPaymentAccount = false;
  }

  const invested = plans.reduce((total, plan) => total + plan.investedTotal, 0n);
  return { shares, cash, invested, hasPaymentAccount };
}

/**
 * Whether a new plan can be funded, and if not, why.
 *
 * This is the one genuinely awkward constraint in the product. An SPL token
 * account holds exactly ONE delegate. Funding a plan means approving that
 * plan's PDA as the delegate on the saver's dollar account, so approving a
 * second plan against the same account silently overwrites the first, and the
 * first plan then fails on its next run with no warning to anybody.
 *
 * Two ways out: give every plan its own dollar account, or allow one plan per
 * account. A separate account per plan means asking a person saving five
 * dollars a week to move money into a second pocket before they can start,
 * and leaves funds stranded there when they stop. For a savings app that is
 * worse than the limit it removes, and v1 does not carry multi asset
 * allocation anyway. So: one plan at a time, blocked in the UI with the
 * existing plan named, rather than a silent overwrite.
 *
 * A delegate that is not one of this owner's plans blocks too. It belongs to
 * something set up elsewhere, and quietly revoking it would be the same
 * failure with a different victim.
 */
/** Who, if anyone, is currently allowed to spend from the saver's dollars. */
export async function currentDelegate(
  connection: Connection,
  owner: PublicKey,
): Promise<string | null> {
  try {
    const account = await getAccount(
      connection,
      ownerPaymentAccount(owner),
      "confirmed",
      TOKEN_PROGRAM_ID,
    );
    if (!account.delegate || account.delegatedAmount === 0n) {
      return null;
    }
    return account.delegate.toBase58();
  } catch {
    return null;
  }
}

export type FundingBlock =
  | { kind: "none" }
  | { kind: "active-plan"; planAddress: string }
  | { kind: "foreign-delegate"; delegate: string };

export async function checkFundingBlock(
  connection: Connection,
  owner: PublicKey,
  plans: Plan[],
): Promise<FundingBlock> {
  // One plan at a time, stated as the product rule rather than as a fact about
  // delegates. An active plan blocks a second one whether or not it currently
  // holds the delegation: starting a second plan would take the delegation for
  // itself and leave the first alive but unable to buy, which is the silent
  // failure this whole check exists to prevent.
  const active = plans.find((plan) => plan.active);
  if (active) {
    return { kind: "active-plan", planAddress: active.address };
  }

  // With no plan of the saver's own running, the only thing that can still
  // block is a delegation belonging to something set up elsewhere. Taking it
  // would be the same silent failure with a different victim.
  const delegate = await currentDelegate(connection, owner);
  if (delegate && !plans.some((plan) => plan.address === delegate)) {
    return { kind: "foreign-delegate", delegate };
  }

  // A cancelled plan's leftover delegation is the saver's own and free to
  // replace.
  return { kind: "none" };
}

export function nextFreeIndex(plans: Plan[]): number {
  const used = new Set(plans.map((plan) => plan.index));
  for (let index = 0; index < 256; index++) {
    if (!used.has(index)) {
      return index;
    }
  }
  throw new Error("no free plan slots");
}

/**
 * The whole of creating a plan, in one transaction and therefore one
 * signature. Three taps to get here, one approval, done.
 *
 * The receipt account is created idempotently in the same transaction because
 * a first time saver does not have one, and settle_execution has nowhere to
 * put their shares without it. Nothing in the program creates it.
 */
export async function buildCreatePlanTransaction(params: {
  program: Program<Idl>;
  owner: PublicKey;
  amount: bigint;
  cadenceSeconds?: number;
  firstRunTs?: number;
  plans: Plan[];
}): Promise<{ transaction: Transaction; planAddress: PublicKey; index: number }> {
  const {
    program,
    owner,
    amount,
    cadenceSeconds = WEEK_SECONDS,
    plans,
  } = params;

  const index = nextFreeIndex(plans);
  const plan = schedulePda(owner, index);
  const payment = ownerPaymentAccount(owner);
  const firstRunTs = params.firstRunTs ?? Math.floor(Date.now() / 1000);

  const instructions: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      ownerReceiptAccount(owner),
      owner,
      RECEIPT_MINT,
      TOKEN_2022_PROGRAM_ID,
    ),
    await program.methods
      .createSchedule(
        index,
        new BN(amount.toString()),
        new BN(cadenceSeconds),
        new BN(firstRunTs),
        // The starting floor is left at zero and the ratchet takes over from
        // the first run. A saver has no way to name a sensible minimum share
        // count before they have bought any, and asking them to would be the
        // opposite of a three tap flow.
        new BN(0),
        2_000,
      )
      .accounts({
        owner,
        vault: VAULT,
        paymentMint: PAYMENT_MINT,
        ownerPaymentAccount: payment,
        schedule: plan,
        paymentTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    // Funding. This is the only authority the program ever has over the
    // saver's money, and revoking it stops everything without the program's
    // cooperation.
    createApproveCheckedInstruction(
      payment,
      PAYMENT_MINT,
      plan,
      owner,
      amount * BigInt(WEEKS_FUNDED),
      book.payment.decimals,
      [],
      TOKEN_PROGRAM_ID,
    ),
  ];

  const transaction = new Transaction().add(...instructions);
  transaction.feePayer = owner;
  return { transaction, planAddress: plan, index };
}

/**
 * Stopping a plan. The program stops honouring it, and the delegation is
 * revoked so nothing can move the saver's money even if the program were
 * wrong about that.
 *
 * The revoke is conditional, and that matters. A token account holds one
 * delegate, so revoking unconditionally would cancel plan A and quietly strip
 * the funding from plan B, leaving B looking alive while every run of it
 * failed. Only the delegation that belongs to the plan being stopped is
 * revoked; anything else is left exactly where it is.
 *
 * Shares already bought are untouched. They are receipt tokens in the saver's
 * own account and nothing here can reach them.
 */
export async function buildCancelPlanTransaction(params: {
  program: Program<Idl>;
  owner: PublicKey;
  planAddress: PublicKey;
}): Promise<Transaction> {
  const { program, owner, planAddress } = params;

  const transaction = new Transaction().add(
    await program.methods
      .cancelSchedule()
      .accounts({ owner, schedule: planAddress })
      .instruction(),
  );

  const delegate = await currentDelegate(
    program.provider.connection,
    owner,
  );
  if (delegate === planAddress.toBase58()) {
    transaction.add(
      createRevokeInstruction(
        ownerPaymentAccount(owner),
        owner,
        [],
        TOKEN_PROGRAM_ID,
      ),
    );
  }

  transaction.feePayer = owner;
  return transaction;
}

/**
 * Re-approves an existing plan that has lost its funding.
 *
 * A live plan with no delegation behind it is a state the one-delegate limit
 * makes reachable: the saver revoked from another wallet, or set something up
 * elsewhere against the same account. The plan keeps saying it will buy on
 * Friday and every run of it is skipped. Better to name it and offer the one
 * tap that fixes it than to let the plan quietly do nothing.
 */
export async function buildResumePlanTransaction(params: {
  owner: PublicKey;
  planAddress: PublicKey;
  amount: bigint;
}): Promise<Transaction> {
  const { owner, planAddress, amount } = params;
  const transaction = new Transaction().add(
    createApproveCheckedInstruction(
      ownerPaymentAccount(owner),
      PAYMENT_MINT,
      planAddress,
      owner,
      amount * BigInt(WEEKS_FUNDED),
      book.payment.decimals,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );
  transaction.feePayer = owner;
  return transaction;
}
