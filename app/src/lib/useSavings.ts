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
import { ASSETS, PARITAS_IDL, VaultEntry } from "./config";
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
  withdraw: (asset: VaultEntry, shares: bigint) => Promise<boolean>;
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
        const signature = await wallet.sendTransaction(transaction, connection);
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
    (asset: VaultEntry, shares: bigint) =>
      run(async (program, owner) => {
        const { transaction } = await buildWithdrawTransaction({
          program,
          owner,
          asset,
          shares,
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
  const program = programError(message);
  if (program) {
    return program;
  }
  if (/User rejected|rejected the request/i.test(message)) {
    return "You cancelled that.";
  }
  if (/insufficient|0x1\b/i.test(message)) {
    return "Not enough in your account to start this plan.";
  }
  if (/blockhash|timed out|fetch/i.test(message)) {
    return "The network was slow to answer. Try that again.";
  }
  return "That did not go through. Try again in a moment.";
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
  Unauthorized: "That plan belongs to a different account.",
};

const ERROR_NAMES = new Map(
  (PARITAS_IDL as { errors?: { code: number; name: string }[] }).errors?.map(
    (entry) => [entry.code, entry.name],
  ) ?? [],
);

function programError(message: string): string | null {
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(message);
  const named = /Error Code: (\w+)/.exec(message);
  const name = named?.[1] ?? (hex ? ERROR_NAMES.get(parseInt(hex[1], 16)) : undefined);
  return name ? PROGRAM_ERROR_COPY[name] ?? null : null;
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
