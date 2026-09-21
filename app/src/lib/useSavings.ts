"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  Funding,
  FundingBlock,
  ForeignDelegateError,
  Holdings,
  PayoutShortError,
  Plan,
  PlanLimits,
  buildCancelPlanTransaction,
  buildChangePlanTransaction,
  buildCreatePlanTransaction,
  buildResumePlanTransaction,
  buildWithdrawTransaction,
  Execution,
  loadExecutions,
  checkFundingBlock,
  confirmSignature,
  getProgram,
  loadFunding,
  loadHoldings,
  loadPlanLimits,
  loadPlans,
} from "./paritas";
import { PublicKey, Transaction } from "@solana/web3.js";
import { ADDRESS_BOOK, ASSETS, PARITAS_IDL, VaultEntry } from "./config";
import type { Quote } from "./portfolio";

/**
 * What the price route gave back. "unavailable" is a normal state, not an
 * error: no key configured, the price service down, or a feed missing. The
 * dashboard shows shares and what was put in either way.
 */
export type Prices =
  | { status: "loading" }
  | { status: "ready"; quotes: Record<string, Quote> }
  | { status: "unavailable" };

const PRICE_REFRESH_MS = 60_000;

/**
 * Said when prices are not live. Plain about why, and about the alternative,
 * without promising an opening time the app does not know for holidays.
 */
export const CASH_OUT_CLOSED =
  "Cash out works while US markets are open. You can take the shares any time.";

/** What cashing out a number of shares would pay, or why it cannot. */
export type CashOutQuote =
  | { kind: "ok"; sharesSold: bigint; paymentOut: bigint }
  | { kind: "short"; available: bigint }
  /** Prices are not live, so nothing is sold. Taking the shares still works. */
  | { kind: "closed" }
  | { kind: "unavailable" };

/** Cash out needs a live price, and US markets have closed since the quote. */
class MarketClosedError extends Error {
  constructor() {
    super("prices are not live");
    this.name = "MarketClosedError";
  }
}

/** The price moved between the quote on screen and the transaction built. */
class CashOutMovedError extends Error {
  constructor() {
    super("the cash out quote changed before signing");
    this.name = "CashOutMovedError";
  }
}

async function requestCashOut(
  owner: PublicKey,
  asset: VaultEntry,
  shares: bigint,
  mode: "quote" | "build",
): Promise<Record<string, string | number>> {
  const response = await fetch("/api/cash-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      owner: owner.toBase58(),
      asset: asset.symbol,
      shares: shares.toString(),
      mode,
    }),
  });
  return { status: response.status, ...(await response.json().catch(() => ({}))) };
}

/**
 * The route's answer as a quote. Short answers carry the most that would
 * work, from whichever limit bit: the fullest wrapper in the vault, or on
 * devnet the liquidity standing in for the market.
 */
export async function quoteCashOut(
  owner: PublicKey,
  asset: VaultEntry,
  shares: bigint,
): Promise<CashOutQuote> {
  try {
    const body = await requestCashOut(owner, asset, shares, "quote");
    if (body.status === 200) {
      return {
        kind: "ok",
        sharesSold: BigInt(body.sharesSold as string),
        paymentOut: BigInt(body.paymentOut as string),
      };
    }
    if (body.error === "vault-short" || body.error === "liquidity-short") {
      return { kind: "short", available: BigInt(body.available as string) };
    }
    if (body.error === "market-closed") {
      return { kind: "closed" };
    }
    return { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

export interface SavingsState {
  loading: boolean;
  plans: Plan[];
  activePlan: Plan | null;
  holdings: Holdings | null;
  fundingBlock: FundingBlock;
  error: string | null;
  /**
   * True when the active plan cannot pay for its next buy: it has no delegation
   * behind it, or the allowance left is smaller than one buy. Reachable because
   * a token account holds one delegate that can be revoked or reassigned from
   * outside this app, and because every buy spends the allowance down.
   */
  activePlanUnfunded: boolean;
  /** The permission on the saver's dollar account, read live. */
  funding: Funding;
  prices: Prices;
  /** Every successful buy across the saver's plans, newest first. */
  executions: Execution[];
  /** The program's floors per asset symbol, or null until read. */
  limits: Record<string, PlanLimits> | null;
  refresh: () => Promise<void>;
  /** Each resolves true when the change landed, false when it did not. */
  createPlan: (
    asset: VaultEntry,
    amount: bigint,
    cadenceSeconds: number,
  ) => Promise<boolean>;
  changePlan: (
    plan: Plan,
    asset: VaultEntry,
    amount: bigint,
    cadenceSeconds: number,
  ) => Promise<boolean>;
  /** wrapperMint only from the advanced withdraw option; otherwise chosen silently. */
  withdraw: (asset: VaultEntry, shares: bigint, wrapperMint?: string) => Promise<boolean>;
  /**
   * Sells shares for dollars in one transaction. Refuses, with a sentence, if
   * the transaction built would pay less than `expected`, the figure the
   * saver agreed to on screen.
   */
  cashOut: (asset: VaultEntry, shares: bigint, expected: bigint) => Promise<boolean>;
  cancelPlan: (plan: Plan) => Promise<boolean>;
  resumePlan: (plan: Plan) => Promise<boolean>;
  clearError: () => void;
  busy: boolean;
}

export function useSavings(): SavingsState {
  const { connection } = useConnection();
  const wallet = useWallet();
  const owner = wallet.publicKey;

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [holdings, setHoldings] = useState<Holdings | null>(null);
  const [fundingBlock, setFundingBlock] = useState<FundingBlock>({ kind: "none" });
  const [funding, setFunding] = useState<Funding>({
    delegate: null,
    delegatedAmount: 0n,
  });
  const [limits, setLimits] = useState<Record<string, PlanLimits> | null>(null);
  const [prices, setPrices] = useState<Prices>({ status: "loading" });
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!owner) {
      setPlans([]);
      setHoldings(null);
      setLoading(false);
      return;
    }
    try {
      const program = getProgram(
        connection,
        wallet as unknown as AnchorProvider["wallet"],
      );
      const loaded = await loadPlans(program, owner);
      const [held, block, fund, planLimits, history] = await Promise.all([
        loadHoldings(connection, owner, loaded),
        checkFundingBlock(connection, owner, loaded),
        loadFunding(connection, owner),
        Promise.all(ASSETS.map((asset) => loadPlanLimits(program, asset))),
        // History is decoration for the streak. Failing to read it must not
        // take the balances down with it.
        loadExecutions(connection, loaded).catch(() => [] as Execution[]),
      ]);
      setExecutions(history);
      setPlans(loaded);
      setHoldings(held);
      setFundingBlock(block);
      setFunding(fund);
      setLimits(
        Object.fromEntries(ASSETS.map((asset, i) => [asset.symbol, planLimits[i]])),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [connection, owner, wallet]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  // Prices refresh on their own clock, independent of the chain reads: they
  // move while the page is open, balances do not.
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const response = await fetch("/api/prices", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        const body = (await response.json()) as {
          prices: Record<string, { price: string; expo: number; publishTime: number }>;
        };
        const quotes: Record<string, Quote> = {};
        for (const [symbol, quote] of Object.entries(body.prices)) {
          quotes[symbol] = {
            price: BigInt(quote.price),
            expo: quote.expo,
            publishTime: quote.publishTime,
          };
        }
        if (live) {
          setPrices({ status: "ready", quotes });
        }
      } catch {
        // A failed refresh keeps the last good quotes: they carry their own
        // publish time, which the screen shows, so they are old rather than
        // wrong. Only a first load that fails is unavailable.
        if (live) {
          setPrices((current) =>
            current.status === "ready" ? current : { status: "unavailable" },
          );
        }
      }
    };
    void load();
    const timer = setInterval(load, PRICE_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  /**
   * Builds, signs, confirms and refreshes. Every action is the same shape, and
   * every one of them owns the busy flag and the error line the same way.
   */
  const run = useCallback(
    async (
      build: (program: ReturnType<typeof getProgram>, owner: PublicKey) => Promise<Transaction>,
      options: { cosigned?: boolean } = {},
    ): Promise<boolean> => {
      if (!owner || !wallet.sendTransaction) {
        return false;
      }
      setBusy(true);
      setError(null);
      try {
        const program = getProgram(
          connection,
          wallet as unknown as AnchorProvider["wallet"],
        );
        const transaction = await build(program, owner);
        let signature: string;
        if (options.cosigned) {
          // Already carries another signature. signTransaction adds the
          // saver's beside it; sendTransaction may rebuild the message on
          // some adapters, which would void the one already there.
          if (!wallet.signTransaction) {
            throw new Error("wallet cannot sign without sending");
          }
          const signed = await wallet.signTransaction(transaction);
          signature = await connection.sendRawTransaction(signed.serialize());
        } else {
          signature = await wallet.sendTransaction(transaction, connection);
        }
        await confirmSignature(connection, signature);
        await refresh();
        return true;
      } catch (err) {
        setError(friendly(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [connection, owner, refresh, wallet],
  );

  const createPlan = useCallback(
    (asset: VaultEntry, amount: bigint, cadenceSeconds: number) =>
      run(async (program, owner) => {
        // Plans are reloaded rather than taken from state, so the index is
        // chosen against the chain as it is now, not as it was on last render.
        const current = await loadPlans(program, owner);
        const { transaction } = await buildCreatePlanTransaction({
          program,
          owner,
          asset,
          amount,
          cadenceSeconds,
          plans: current,
        });
        return transaction;
      }),
    [run],
  );

  const changePlan = useCallback(
    (plan: Plan, asset: VaultEntry, amount: bigint, cadenceSeconds: number) =>
      run(async (program, owner) => {
        const current = await loadPlans(program, owner);
        const { transaction } = await buildChangePlanTransaction({
          program,
          owner,
          plan,
          asset,
          amount,
          cadenceSeconds,
          plans: current,
        });
        return transaction;
      }),
    [run],
  );

  const withdraw = useCallback(
    (asset: VaultEntry, shares: bigint, wrapperMint?: string) =>
      run(async (program, owner) => {
        const { transaction } = await buildWithdrawTransaction({
          program,
          owner,
          asset,
          shares,
          wrapperMint,
        });
        return transaction;
      }),
    [run],
  );

  const cancelPlan = useCallback(
    (plan: Plan) =>
      run((program, owner) =>
        buildCancelPlanTransaction({
          program,
          owner,
          planAddress: new PublicKey(plan.address),
        }),
      ),
    [run],
  );

  const resumePlan = useCallback(
    (plan: Plan) =>
      run((_program, owner) =>
        buildResumePlanTransaction({
          owner,
          planAddress: new PublicKey(plan.address),
          amount: plan.amount,
        }),
      ),
    [run],
  );

  const cashOut = useCallback(
    (asset: VaultEntry, shares: bigint, expected: bigint) =>
      run(
        async (_program, owner) => {
          const body = await requestCashOut(owner, asset, shares, "build");
          if (body.status !== 200) {
            if (body.error === "vault-short" || body.error === "liquidity-short") {
              throw new PayoutShortError(BigInt(body.available as string));
            }
            if (body.error === "market-closed") {
              throw new MarketClosedError();
            }
            throw new Error(`cash out ${body.error ?? body.status}`);
          }
          if (BigInt(body.paymentOut as string) < expected) {
            throw new CashOutMovedError();
          }
          return Transaction.from(
            Uint8Array.from(atob(body.transaction as string), (c) => c.charCodeAt(0)),
          );
        },
        { cosigned: true },
      ),
    [run],
  );

  const clearError = useCallback(() => setError(null), []);

  const activePlan = plans.find((plan) => plan.active) ?? null;
  const activePlanUnfunded =
    activePlan !== null &&
    (funding.delegate !== activePlan.address ||
      funding.delegatedAmount < activePlan.amount);

  return {
    activePlanUnfunded,
    funding,
    limits,
    prices,
    executions,
    changePlan,
    withdraw,
    cashOut,
    clearError,
    resumePlan,
    loading,
    plans,
    activePlan,
    holdings,
    fundingBlock,
    error,
    refresh,
    createPlan,
    cancelPlan,
    busy,
  };
}

/**
 * Wallet and RPC errors are written for developers. A person who declined a
 * prompt, or whose connection dropped, should not be shown a stack trace.
 */
function friendly(err: unknown): string {
  if (err instanceof MarketClosedError) {
    return CASH_OUT_CLOSED;
  }
  if (err instanceof CashOutMovedError) {
    return "The price changed a moment ago. Check the new amount and try again.";
  }
  if (err instanceof PayoutShortError) {
    if (err.available === 0n) {
      return "That is too small to take out. Try a larger amount.";
    }
    // Rounded down, so the figure offered is one that will actually work.
    const scale = 10 ** (ASSETS[0].receiptDecimals - 4);
    const most = (Math.floor(Number(err.available) / scale) / 10_000).toLocaleString(
      undefined,
      { maximumFractionDigits: 4 },
    );
    return `Right now you can take out up to ${most} shares at once. Try that, or a smaller amount.`;
  }
  if (err instanceof ForeignDelegateError) {
    return "Something else has permission to spend from your account, so we have left your plan as it was.";
  }
  const message = errorText(err);

  // Before anything else, because a wallet on the wrong network produces
  // errors that read like ordinary failures: the program, the vaults and the
  // test dollars exist only on devnet, so a wallet pointed at mainnet sends a
  // transaction that cannot reference any of them. Telling that person to
  // "try again in a moment" sends them round the same loop forever.
  if (wrongNetwork(message)) {
    return WRONG_NETWORK;
  }
  if (/User rejected|rejected the request|User denied/i.test(message)) {
    return "You cancelled that.";
  }
  const program = programError(message);
  if (program) {
    return program;
  }
  if (/insufficient lamports|insufficient funds for rent|0x1\b/i.test(message)) {
    return "Not enough in your account to start this plan.";
  }
  if (/timed out waiting for confirmation/i.test(message)) {
    return (
      "The network did not confirm that in time. It may still land: check " +
      "your wallet before trying again."
    );
  }
  if (/blockhash|timed out|failed to fetch|network error/i.test(message)) {
    return "The network was slow to answer. Try that again.";
  }
  return unexplained(message);
}

/**
 * The app talks to one cluster, and the address book names it. A wallet set to
 * another one cannot see the program or the test dollars, and the wallet has
 * no way to be asked which network it is on: the Wallet Standard exposes no
 * such query, so this is inferred from what the failure looked like.
 *
 * Each of these means "the thing the transaction referred to is not here".
 * On an app whose every address is devnet only, that is the wrong network
 * far more often than it is anything else.
 */
function wrongNetwork(message: string): boolean {
  // If our own program logged an invocation, it exists on whatever cluster the
  // transaction reached, so the network is right and the failure is something
  // else. This guard matters because the account checks below are broad on
  // purpose, and a real program refusal must not be reported as a wallet
  // pointed at the wrong chain.
  if (new RegExp(`Program ${ADDRESS_BOOK.programId} invoke`).test(message)) {
    return false;
  }
  return (
    /Attempt to load a program that does not exist/i.test(message) ||
    /ProgramAccountNotFound/i.test(message) ||
    /Blockhash not found|BlockhashNotFound/i.test(message) ||
    new RegExp(`${ADDRESS_BOOK.programId}[^\\n]*(not exist|unknown|invalid)`, "i").test(
      message,
    ) ||
    /AccountNotFound|could not find account/i.test(message)
  );
}

const WRONG_NETWORK =
  `Your wallet looks like it is on the wrong network. This app runs on ` +
  `Solana ${ADDRESS_BOOK.cluster}. Open your wallet's settings, switch the ` +
  `network to ${ADDRESS_BOOK.cluster}, then try again.`;

/**
 * The last resort, and deliberately not a shrug. A failure nothing above
 * recognised still has a real reason in it, and hiding that behind "try again
 * in a moment" is what leaves a tester with nothing to report and no way
 * forward. So the plainest line of the underlying error is shown alongside
 * the apology: program logs and stack frames are dropped, the sentence a
 * person or a developer can act on is kept.
 */
function unexplained(message: string): string {
  const skip =
    /^(Program |> Program|    at |Logs?:|\[|\{|transaction failed:|custom program error)/i;
  const line = message
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0 && part.length < 200 && !skip.test(part));

  return line
    ? `That did not go through. The wallet reported: ${line}`
    : "That did not go through, and no reason came back. Try again in a moment.";
}

/**
 * The program's refusals, in the saver's words. The screen checks the same
 * rules before the wallet is asked, so these are the backstop for when the
 * chain disagrees with what the screen knew: the vault's keeper fee retuned
 * since the page loaded, say. Codes are looked up by name in the IDL rather
 * than written as numbers, so reordering the program's errors cannot quietly
 * point one of these at the wrong message.
 */
const PROGRAM_ERROR_COPY: Record<string, string> = {
  AmountBelowDustFloor: "That amount is below the smallest plan. Try a little more.",
  AmountCannotCoverKeeperFee:
    "That amount is too small for a plan right now. Try a little more.",
  CadenceTooShort: "Plans can run at most once an hour.",
  ScheduleInactive: "That plan has already stopped.",
  InsufficientVaultBalance:
    "That can't be paid out in full right now. Try a smaller amount.",
  ZeroAmount: "That is too small to take out. Try a larger amount.",
  CashOutBelowMinimum:
    "The sale came in under the amount you agreed to, so nothing happened. Try again.",
  Unauthorized: "That plan belongs to a different account.",
};

type IdlError = { code: number; name: string; msg?: string };

const IDL_ERRORS = (PARITAS_IDL as { errors?: IdlError[] }).errors ?? [];

const ERROR_NAMES = new Map(IDL_ERRORS.map((entry) => [entry.code, entry.name]));

/**
 * The program's own message for every refusal that has no hand written line
 * above. PROGRAM_ERROR_COPY covers the ones a saver can actually hit and act
 * on; the rest are conditions the screen already prevents, so they should be
 * unreachable. "Should be" is the reason this exists: if one does reach a
 * saver, the program's description of it is a far better thing to show than a
 * shrug, and it is what makes a bug report possible.
 */
const ERROR_MESSAGES = new Map(
  IDL_ERRORS.filter((entry) => entry.msg).map((entry) => [entry.name, entry.msg as string]),
);

function programError(message: string): string | null {
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(message);
  const named = /Error Code: (\w+)/.exec(message);
  // The decimal form, from a signature status err that reached here without
  // logs: {"InstructionError":[0,{"Custom":6011}]}. Without this branch a
  // transaction that landed and then failed has a known reason that nothing
  // reads, and the saver is told only that it did not go through.
  const custom = /"?Custom"?\s*:\s*(\d+)/.exec(message);
  const name =
    named?.[1] ??
    (hex ? ERROR_NAMES.get(parseInt(hex[1], 16)) : undefined) ??
    (custom ? ERROR_NAMES.get(parseInt(custom[1], 10)) : undefined);
  if (!name) {
    return null;
  }
  const copy = PROGRAM_ERROR_COPY[name];
  if (copy) {
    return copy;
  }
  const msg = ERROR_MESSAGES.get(name);
  return msg ? `That did not go through: ${msg}.` : null;
}

/**
 * Wallet adapters wrap the simulation failure, and the program's error code is
 * in the logs of the inner error rather than in the outer message.
 */
function errorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < 4; depth++) {
    if (current instanceof Error) {
      parts.push(current.message);
      const logs = (current as { logs?: unknown }).logs;
      if (Array.isArray(logs)) {
        parts.push(...logs.map(String));
      }
      current = (current as { error?: unknown; cause?: unknown }).error ??
        (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join("\n");
}
