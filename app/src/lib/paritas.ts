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
  getMint,
  getScaledUiAmountConfig,
} from "@solana/spl-token";
import {
  ADDRESS_BOOK,
  ASSETS,
  PARITAS_IDL,
  VaultEntry,
  WEEK_SECONDS,
  Wrapper,
} from "./config";

const book = ADDRESS_BOOK;

export const PROGRAM_ID = new PublicKey(book.programId);
export const PAYMENT_MINT = new PublicKey(book.payment.mint);

/**
 * Buys a plan is funded for up front, whatever its cadence. Counted in buys
 * rather than weeks so the permission the saver grants is stated in the one
 * unit that does not change meaning between a daily and a monthly plan: twelve
 * buys at the amount they chose, and not a cent more.
 */
export const RUNS_FUNDED = 12;

/**
 * Mirrors of the program's own limits, from programs/paritas/src/state.rs.
 * They are not in the IDL, which only carries what #[constant] marks, so they
 * are restated here and must move with the program if it ever changes them.
 * The program remains the enforcer; these exist so a saver hears "the smallest
 * plan is $2.50" before signing, rather than a failed transaction after.
 */
export const MIN_CADENCE_SECONDS = 3_600;
const MAX_KEEPER_FEE_BPS = 200n;

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

export function schedulePda(
  owner: PublicKey,
  asset: VaultEntry,
  index: number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      utf8.encode(book.seeds.schedule),
      owner.toBytes(),
      new PublicKey(asset.address).toBytes(),
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

export function ownerReceiptAccount(owner: PublicKey, asset: VaultEntry): PublicKey {
  return getAssociatedTokenAddressSync(
    new PublicKey(asset.receiptMint),
    owner,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
}

export interface Plan {
  address: string;
  /** Symbol of the vault this plan buys into; see ASSETS. */
  asset: string;
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

/**
 * Every plan this owner has on any vault this app knows, ordered by vault then
 * index. A plan on a vault missing from the address book is left out: there is
 * nothing on screen that could honestly describe it.
 */
export async function loadPlans(
  program: Program<Idl>,
  owner: PublicKey,
): Promise<Plan[]> {
  const accounts = await (program.account as any).schedule.all([
    { memcmp: { offset: 8, bytes: owner.toBase58() } },
  ]);
  const symbolOf = new Map(ASSETS.map((asset) => [asset.address, asset.symbol]));

  return (accounts as { publicKey: PublicKey; account: RawSchedule }[])
    .filter((entry) => symbolOf.has(entry.account.vault.toBase58()))
    .map((entry) => ({
      address: entry.publicKey.toBase58(),
      asset: symbolOf.get(entry.account.vault.toBase58())!,
      index: entry.account.scheduleIndex,
      amount: BigInt(entry.account.amountUsdc.toString()),
      cadenceSeconds: entry.account.cadenceSeconds.toNumber(),
      nextDueTs: entry.account.nextDueTs.toNumber(),
      executions: entry.account.executions.toNumber(),
      investedTotal: BigInt(entry.account.totalUsdcSpent.toString()),
      sharesTotal: BigInt(entry.account.totalEquityUnits.toString()),
      active: entry.account.active,
    }))
    .sort((a, b) => a.asset.localeCompare(b.asset) || a.index - b.index);
}

export interface PlanLimits {
  /** Smallest amount create_schedule will accept, in raw payment units. */
  minAmount: bigint;
  minCadenceSeconds: number;
}

/**
 * The smallest plan the program will take, read against the live vault.
 *
 * Two floors apply and the larger wins. The dust floor is one whole unit of the
 * payment mint. The keeper floor is the amount whose capped fee still covers
 * the vault's minimum keeper fee; below it no keeper would ever run the plan,
 * and create_schedule refuses it. The minimum fee is read from the vault
 * account rather than the address book, because the vault authority can retune
 * it at any time with set_keeper_fee and the address book would not notice.
 */
export async function loadPlanLimits(
  program: Program<Idl>,
  asset: VaultEntry,
): Promise<PlanLimits> {
  const vault = await (program.account as any).vault.fetch(
    new PublicKey(asset.address),
  );
  const feeMin = BigInt(vault.keeperFeeMin.toString());

  const dustFloor = 10n ** BigInt(book.payment.decimals);
  // Smallest amount with amount * MAX / 10_000 >= feeMin, the program's check
  // solved for amount and rounded up.
  const keeperFloor = (feeMin * 10_000n + MAX_KEEPER_FEE_BPS - 1n) / MAX_KEEPER_FEE_BPS;

  return {
    minAmount: dustFloor > keeperFloor ? dustFloor : keeperFloor,
    minCadenceSeconds: MIN_CADENCE_SECONDS,
  };
}

const U64_MAX = (1n << 64n) - 1n;

/**
 * Why a plan cannot be set up as described, in words a saver can act on, or
 * null when it can. Run before the wallet is ever asked, so the answer to a
 * too small amount is a sentence on screen and not a failed transaction.
 */
export function planProblem(params: {
  amount: bigint | null;
  cadenceSeconds: number;
  limits: PlanLimits;
  cash: bigint;
  moneyDecimals: number;
}): string | null {
  const { amount, cadenceSeconds, limits, cash, moneyDecimals } = params;

  if (amount === null) {
    return "Enter an amount in dollars and cents.";
  }
  if (cadenceSeconds < limits.minCadenceSeconds) {
    return "Plans can run at most once an hour.";
  }
  if (amount < limits.minAmount) {
    return `The smallest plan is ${dollars(limits.minAmount, moneyDecimals)} each time.`;
  }
  if (amount * BigInt(RUNS_FUNDED) > U64_MAX) {
    return "That amount is too large.";
  }
  if (amount > cash) {
    return `You have ${dollars(cash, moneyDecimals)} in your account, not enough for the first buy.`;
  }
  return null;
}

function dollars(raw: bigint, decimals: number): string {
  return (Number(raw) / 10 ** decimals).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

export interface Funding {
  /** Whoever may spend from the saver's dollars, or null for nobody. */
  delegate: string | null;
  /** How much more they may take, in raw payment units. */
  delegatedAmount: bigint;
}

/**
 * The permission on the saver's dollar account, as it stands on chain.
 *
 * This is the real limit on what the app can take, not the plan. The plan says
 * how much and how often; the delegation says how much in total, and the
 * program cannot move a cent past it. It shrinks with every buy, so it is read
 * fresh rather than derived from what was approved at creation.
 */
export async function loadFunding(
  connection: Connection,
  owner: PublicKey,
): Promise<Funding> {
  try {
    const account = await getAccount(
      connection,
      ownerPaymentAccount(owner),
      "confirmed",
      TOKEN_PROGRAM_ID,
    );
    if (!account.delegate || account.delegatedAmount === 0n) {
      return { delegate: null, delegatedAmount: 0n };
    }
    return {
      delegate: account.delegate.toBase58(),
      delegatedAmount: account.delegatedAmount,
    };
  } catch {
    return { delegate: null, delegatedAmount: 0n };
  }
}

export interface Holdings {
  /**
   * Shares actually held per asset symbol, read off each receipt token
   * account. Kept apart because a share of one asset and a share of another
   * are not the same thing and do not add up to anything.
   */
  shares: Record<string, bigint>;
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
  const shares: Record<string, bigint> = {};
  let cash = 0n;
  let hasPaymentAccount = false;

  await Promise.all(
    ASSETS.map(async (asset) => {
      try {
        const receipt = await getAccount(
          connection,
          ownerReceiptAccount(owner, asset),
          "confirmed",
          TOKEN_2022_PROGRAM_ID,
        );
        shares[asset.symbol] = receipt.amount;
      } catch {
        // No receipt account yet means no shares yet, which is the correct
        // answer for somebody who has not bought any of this asset.
        shares[asset.symbol] = 0n;
      }
    }),
  );

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
/**
 * Waits for a transaction to confirm, over HTTP.
 *
 * connection.confirmTransaction subscribes over a websocket, and this app
 * reaches the chain through its own /api/rpc proxy, which forwards JSON-RPC
 * over HTTP and nothing else. web3.js would derive a wss:// url from the proxy
 * path, find nothing listening, and wait forever. Polling the signature status
 * asks the same question over the transport that actually exists.
 *
 * Resolves on confirmation, throws if the chain reports the transaction
 * failed, and gives up after the timeout rather than hanging the button.
 */
export async function confirmSignature(
  connection: Connection,
  signature: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];

    if (status) {
      if (status.err) {
        throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
      }
      if (
        status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized"
      ) {
        return;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error("timed out waiting for confirmation");
}

/** Who, if anyone, is currently allowed to spend from the saver's dollars. */
export async function currentDelegate(
  connection: Connection,
  owner: PublicKey,
): Promise<string | null> {
  return (await loadFunding(connection, owner)).delegate;
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

/**
 * The lowest unused plan index on one asset. Indexes are per vault, since the
 * vault is one of the schedule's seeds, so plans on another asset do not use
 * one up here.
 */
export function nextFreeIndex(plans: Plan[], asset: VaultEntry): number {
  const used = new Set(
    plans.filter((plan) => plan.asset === asset.symbol).map((plan) => plan.index),
  );
  for (let index = 0; index < 256; index++) {
    if (!used.has(index)) {
      return index;
    }
  }
  throw new Error("no free plan slots");
}

/**
 * The instructions that bring one plan into being and fund it: the receipt
 * account, the schedule, and the approval. Shared by creating a plan and by
 * changing one, which is the same three instructions behind a cancel.
 *
 * The receipt account is created idempotently because a first time saver does
 * not have one, and settle_execution has nowhere to put their shares without
 * it. Nothing in the program creates it.
 */
async function newPlanInstructions(params: {
  program: Program<Idl>;
  owner: PublicKey;
  asset: VaultEntry;
  amount: bigint;
  cadenceSeconds: number;
  firstRunTs: number;
  plans: Plan[];
}): Promise<{
  instructions: TransactionInstruction[];
  planAddress: PublicKey;
  index: number;
}> {
  const { program, owner, asset, amount, cadenceSeconds, firstRunTs, plans } = params;

  // A cancelled plan keeps its index for good, since cancel_schedule leaves the
  // account in place, so every plan including the one being replaced counts as
  // taken here.
  const index = nextFreeIndex(plans, asset);
  const plan = schedulePda(owner, asset, index);
  const payment = ownerPaymentAccount(owner);

  const instructions: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      ownerReceiptAccount(owner, asset),
      owner,
      new PublicKey(asset.receiptMint),
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
        vault: new PublicKey(asset.address),
        paymentMint: PAYMENT_MINT,
        ownerPaymentAccount: payment,
        schedule: plan,
        paymentTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    // Funding. This is the only authority the program ever has over the
    // saver's money, and revoking it stops everything without the program's
    // cooperation. An approve replaces whatever allowance stood before, so a
    // changed plan is funded for exactly its own buys and nothing carries over.
    createApproveCheckedInstruction(
      payment,
      PAYMENT_MINT,
      plan,
      owner,
      amount * BigInt(RUNS_FUNDED),
      book.payment.decimals,
      [],
      TOKEN_PROGRAM_ID,
    ),
  ];

  return { instructions, planAddress: plan, index };
}

/**
 * The whole of creating a plan, in one transaction and therefore one
 * signature. Three taps to get here, one approval, done.
 */
export async function buildCreatePlanTransaction(params: {
  program: Program<Idl>;
  owner: PublicKey;
  asset?: VaultEntry;
  amount: bigint;
  cadenceSeconds?: number;
  firstRunTs?: number;
  plans: Plan[];
}): Promise<{ transaction: Transaction; planAddress: PublicKey; index: number }> {
  const {
    program,
    owner,
    asset = ASSETS[0],
    amount,
    cadenceSeconds = WEEK_SECONDS,
    plans,
  } = params;

  const { instructions, planAddress, index } = await newPlanInstructions({
    program,
    owner,
    asset,
    amount,
    cadenceSeconds,
    firstRunTs: params.firstRunTs ?? Math.floor(Date.now() / 1000),
    plans,
  });

  const transaction = new Transaction().add(...instructions);
  transaction.feePayer = owner;
  return { transaction, planAddress, index };
}

/**
 * Changing a plan's amount or cadence: the old plan cancelled and a new one
 * created and funded, all in one transaction.
 *
 * There is no update instruction, and one would not save a signature. The
 * allowance is denominated in the amount, so changing the amount means a fresh
 * approval regardless, and a single transaction already makes the whole change
 * one wallet prompt. It also means there is never a moment where both plans
 * are live, or neither: the cancel and the create land together or not at all.
 *
 * The next buy keeps its date where it can. Replacing a plan three days before
 * Friday should not buy today as well, so the new plan starts on the old one's
 * next due date, pulled in if the new cadence is shorter so that switching
 * from monthly to daily does not wait out the rest of the month.
 *
 * The asset can change too. The cancel names only the old schedule, so the old
 * and new plans may sit on different vaults and the transaction is the same
 * shape either way.
 *
 * The delegation is taken over only from this saver's own plans. If something
 * set up elsewhere holds it, approving here would silently strip its funding,
 * the same failure checkFundingBlock guards creation against.
 */
export async function buildChangePlanTransaction(params: {
  program: Program<Idl>;
  owner: PublicKey;
  plan: Plan;
  asset: VaultEntry;
  amount: bigint;
  cadenceSeconds: number;
  plans: Plan[];
}): Promise<{ transaction: Transaction; planAddress: PublicKey; index: number }> {
  const { program, owner, plan, asset, amount, cadenceSeconds, plans } = params;

  const delegate = await currentDelegate(program.provider.connection, owner);
  if (delegate && !plans.some((existing) => existing.address === delegate)) {
    throw new ForeignDelegateError();
  }

  const now = Math.floor(Date.now() / 1000);
  const firstRunTs = Math.min(Math.max(plan.nextDueTs, now), now + cadenceSeconds);

  const { instructions, planAddress, index } = await newPlanInstructions({
    program,
    owner,
    asset,
    amount,
    cadenceSeconds,
    firstRunTs,
    plans,
  });

  const transaction = new Transaction().add(
    await program.methods
      .cancelSchedule()
      .accounts({ owner, schedule: new PublicKey(plan.address) })
      .instruction(),
    ...instructions,
  );
  transaction.feePayer = owner;
  return { transaction, planAddress, index };
}

/** Something other than this saver's own plans holds the delegation. */
export class ForeignDelegateError extends Error {
  constructor() {
    super("the dollar account is delegated to something outside this app");
    this.name = "ForeignDelegateError";
  }
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
      amount * BigInt(RUNS_FUNDED),
      book.payment.decimals,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );
  transaction.feePayer = owner;
  return transaction;
}

// --- taking money out -------------------------------------------------------

/**
 * Fixed point scales, mirroring programs/paritas/src/multiplier.rs. Withdraw
 * pays out at the wrapper's own multiplier, so showing a saver what they will
 * receive means repeating the program's integer math exactly, not
 * approximating it: a preview that says 0.5000 and a wallet that receives
 * 0.4999 is the kind of small untruth this app is not allowed to tell.
 */
const MULTIPLIER_SCALE = 1_000_000_000_000_000_000n;
const RATE_SCALE = 1_000_000_000n;
const EQUITY_UNIT_DECIMALS = 9;

/**
 * multiplier::current_multiplier_fixed. The one float step, a multiply and a
 * round, happens exactly as the program does it; BigInt from there on.
 */
function multiplierFixed(
  multiplier: number,
  newMultiplier: number,
  effectiveTs: number,
  now: number,
): bigint {
  const chosen = now >= effectiveTs ? newMultiplier : multiplier;
  if (!Number.isFinite(chosen) || chosen <= 0) {
    throw new Error("invalid multiplier on wrapper mint");
  }
  return BigInt(Math.round(chosen * Number(MULTIPLIER_SCALE)));
}

/** multiplier::compute_rate. */
function computeRate(
  multAFixed: bigint,
  decimalsA: number,
  multBFixed: bigint,
  decimalsB: number,
): bigint {
  let numerator = multAFixed * RATE_SCALE;
  let denominator = multBFixed;
  if (decimalsB >= decimalsA) {
    numerator *= 10n ** BigInt(decimalsB - decimalsA);
  } else {
    denominator *= 10n ** BigInt(decimalsA - decimalsB);
  }
  return numerator / denominator;
}

/** multiplier::to_equity_units. Rounds down. */
function toEquityUnits(raw: bigint, decimals: number, multFixed: bigint): bigint {
  return (
    (raw * computeRate(multFixed, decimals, MULTIPLIER_SCALE, EQUITY_UNIT_DECIMALS)) /
    RATE_SCALE
  );
}

/** multiplier::from_equity_units. Rounds down. */
function fromEquityUnits(units: bigint, decimals: number, multFixed: bigint): bigint {
  return (
    (units * computeRate(MULTIPLIER_SCALE, EQUITY_UNIT_DECIMALS, multFixed, decimals)) /
    RATE_SCALE
  );
}

/** One wrapper the vault could pay out, as it stands on chain right now. */
export interface PayoutSource {
  wrapper: Wrapper;
  /** Raw wrapper units the vault holds. */
  vaultBalance: bigint;
  multFixed: bigint;
}

/**
 * The vault's holding of each wrapper and each wrapper's live multiplier,
 * which are the two things withdraw's payout depends on.
 */
export async function loadPayoutSources(
  connection: Connection,
  asset: VaultEntry,
): Promise<PayoutSource[]> {
  const now = Math.floor(Date.now() / 1000);
  return Promise.all(
    asset.wrappers.map(async (wrapper) => {
      const mint = await getMint(
        connection,
        new PublicKey(wrapper.mint),
        "confirmed",
        TOKEN_2022_PROGRAM_ID,
      );
      const config = getScaledUiAmountConfig(mint);
      if (!config) {
        throw new Error("wrapper mint has no scaled amount config");
      }
      let vaultBalance = 0n;
      try {
        vaultBalance = (
          await getAccount(
            connection,
            new PublicKey(wrapper.vaultTokenAccount),
            "confirmed",
            TOKEN_2022_PROGRAM_ID,
          )
        ).amount;
      } catch {
        // No holding account means nothing to pay out of this wrapper.
      }
      return {
        wrapper,
        vaultBalance,
        multFixed: multiplierFixed(
          config.multiplier,
          config.newMultiplier,
          Number(config.newMultiplierEffectiveTimestamp),
          now,
        ),
      };
    }),
  );
}

/** One withdraw instruction: this many equity units out of this wrapper. */
export interface PayoutLeg {
  source: PayoutSource;
  shares: bigint;
  rawOut: bigint;
}

export type Payout =
  | {
      kind: "ok";
      legs: PayoutLeg[];
      /** Shares the saver actually ends up holding in their wallet. */
      received: bigint;
    }
  | { kind: "short"; available: bigint };

/**
 * Which wrapper, or wrappers, pay out a withdrawal of `shares`.
 *
 * The saver asked for shares of NVIDIA and gets shares of NVIDIA; which
 * wrapper carries them is this function's problem, not theirs, and nothing it
 * decides reaches the screen. It prefers one wrapper that covers the whole
 * amount, the one holding most, so the saver ends up with one kind of token
 * rather than two. Only when no single wrapper can cover it does it split, in
 * one transaction, largest holding first.
 *
 * A wrapper's capacity is what its whole balance is worth in shares, rounded
 * down, and paying out that many shares never needs more than the balance,
 * because both conversions round down. So a plan this returns is one the
 * program's InsufficientVaultBalance check will accept.
 *
 * "short" means the vault as a whole cannot pay this right now. Receipts are
 * backed one for one, so that should only ever be a rounding sliver, but it is
 * stated as a plain answer rather than left to fail on chain.
 */
export function planPayout(shares: bigint, sources: PayoutSource[]): Payout {
  const capacity = (source: PayoutSource) =>
    toEquityUnits(source.vaultBalance, source.wrapper.decimals, source.multFixed);

  const ranked = [...sources].sort((a, b) =>
    capacity(b) > capacity(a) ? 1 : capacity(b) < capacity(a) ? -1 : 0,
  );

  const leg = (source: PayoutSource, units: bigint): PayoutLeg => ({
    source,
    shares: units,
    rawOut: fromEquityUnits(units, source.wrapper.decimals, source.multFixed),
  });

  const whole = ranked.find((source) => capacity(source) >= shares);
  let legs: PayoutLeg[];
  if (whole) {
    legs = [leg(whole, shares)];
  } else {
    legs = [];
    let remaining = shares;
    for (const source of ranked) {
      if (remaining === 0n) {
        break;
      }
      const take = capacity(source) < remaining ? capacity(source) : remaining;
      if (take > 0n) {
        legs.push(leg(source, take));
        remaining -= take;
      }
    }
    if (remaining > 0n) {
      const available = ranked.reduce((sum, source) => sum + capacity(source), 0n);
      return { kind: "short", available };
    }
  }

  // withdraw refuses a leg that pays out nothing (ZeroAmount), which a tiny
  // amount can round to. Such a leg is dropped, and if that leaves nothing,
  // the amount is too small to take out at all.
  legs = legs.filter((each) => each.rawOut > 0n);
  if (legs.length === 0) {
    return { kind: "short", available: 0n };
  }

  const received = legs.reduce(
    (sum, each) =>
      sum + toEquityUnits(each.rawOut, each.source.wrapper.decimals, each.source.multFixed),
    0n,
  );
  return { kind: "ok", legs, received };
}

/** A payout the vault cannot make, with what it could. */
export class PayoutShortError extends Error {
  constructor(readonly available: bigint) {
    super("the vault cannot pay out that many shares right now");
    this.name = "PayoutShortError";
  }
}

/**
 * Taking shares out of savings and into the saver's own wallet, as one
 * transaction. The payout is planned against the chain as it is at build
 * time, not as the screen last saw it, so a vault that emptied in between is
 * caught here with a sentence rather than on chain with a failure.
 */
export async function buildWithdrawTransaction(params: {
  program: Program<Idl>;
  owner: PublicKey;
  asset: VaultEntry;
  shares: bigint;
}): Promise<{ transaction: Transaction; received: bigint }> {
  const { program, owner, asset, shares } = params;
  const sources = await loadPayoutSources(program.provider.connection, asset);
  const payout = planPayout(shares, sources);
  if (payout.kind === "short") {
    throw new PayoutShortError(payout.available);
  }

  const vault = new PublicKey(asset.address);
  const receiptMint = new PublicKey(asset.receiptMint);
  const transaction = new Transaction();
  for (const leg of payout.legs) {
    const mint = new PublicKey(leg.source.wrapper.mint);
    const userWrapperAccount = getAssociatedTokenAddressSync(
      mint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    transaction.add(
      // Where the shares land. A saver who has only ever bought through a plan
      // has never held the wrapper directly, so the account may not exist.
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        userWrapperAccount,
        owner,
        mint,
        TOKEN_2022_PROGRAM_ID,
      ),
      await program.methods
        .withdraw(new BN(leg.shares.toString()))
        .accounts({
          user: owner,
          vault,
          wrapper: new PublicKey(leg.source.wrapper.wrapper),
          wrapperMint: mint,
          vaultWrapperAccount: new PublicKey(leg.source.wrapper.vaultTokenAccount),
          userWrapperAccount,
          receiptMint,
          userReceiptAccount: ownerReceiptAccount(owner, asset),
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .instruction(),
    );
  }
  transaction.feePayer = owner;
  return { transaction, received: payout.received };
}

// --- execution history ------------------------------------------------------

/** When one buy happened, and the pace of the plan that made it. */
export interface Execution {
  ts: number;
  cadenceSeconds: number;
  plan: string;
}

/**
 * Every successful buy across these plans, newest first, with its real time.
 *
 * The schedule only counts executions; it does not record when they happened,
 * so a count alone cannot tell a plan that ran fourteen weeks straight from
 * one that ran fourteen times across a year. The times come from chain
 * history instead, off the execution receipt PDA: begin_execution creates it
 * and settle_execution closes it, both in the one transaction, and nothing
 * else touches that address. Its successful signatures are therefore exactly
 * this plan's buys. The schedule account itself would not do, because the
 * saver's own create, cancel and approve transactions touch it too.
 */
export async function loadExecutions(
  connection: Connection,
  plans: Plan[],
): Promise<Execution[]> {
  const perPlan = await Promise.all(
    plans
      .filter((plan) => plan.executions > 0)
      .map(async (plan) => {
        const [receipt] = PublicKey.findProgramAddressSync(
          [
            utf8.encode(book.seeds.executionReceipt),
            new PublicKey(plan.address).toBytes(),
          ],
          PROGRAM_ID,
        );
        const signatures = await connection.getSignaturesForAddress(
          receipt,
          { limit: 1000 },
          "confirmed",
        );
        return signatures
          .filter((entry) => entry.err === null && entry.blockTime)
          .map((entry) => ({
            ts: entry.blockTime!,
            cadenceSeconds: plan.cadenceSeconds,
            plan: plan.address,
          }));
      }),
  );
  return perPlan.flat().sort((a, b) => b.ts - a.ts);
}
