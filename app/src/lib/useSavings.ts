"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  FundingBlock,
  Holdings,
  Plan,
  buildCancelPlanTransaction,
  buildCreatePlanTransaction,
  buildResumePlanTransaction,
  checkFundingBlock,
  currentDelegate,
  getProgram,
  loadHoldings,
  loadPlans,
} from "./paritas";
import { PublicKey } from "@solana/web3.js";

export interface SavingsState {
  loading: boolean;
  plans: Plan[];
  activePlan: Plan | null;
  holdings: Holdings | null;
  fundingBlock: FundingBlock;
  error: string | null;
  /**
   * True when the active plan has no delegation behind it, so every run of it
   * is being skipped. Reachable because a token account holds one delegate and
   * it can be revoked or reassigned from outside this app.
   */
  activePlanUnfunded: boolean;
  refresh: () => Promise<void>;
  createPlan: (amount: bigint) => Promise<void>;
  cancelPlan: (plan: Plan) => Promise<void>;
  resumePlan: (plan: Plan) => Promise<void>;
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
  const [delegate, setDelegate] = useState<string | null>(null);
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
      const [held, block, currentDel] = await Promise.all([
        loadHoldings(connection, owner, loaded),
        checkFundingBlock(connection, owner, loaded),
        currentDelegate(connection, owner),
      ]);
      setPlans(loaded);
      setHoldings(held);
      setFundingBlock(block);
      setDelegate(currentDel);
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

  const createPlan = useCallback(
    async (amount: bigint) => {
      if (!owner || !wallet.sendTransaction) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const program = getProgram(
          connection,
          wallet as unknown as AnchorProvider["wallet"],
        );
        const current = await loadPlans(program, owner);
        const { transaction } = await buildCreatePlanTransaction({
          program,
          owner,
          amount,
          plans: current,
        });
        const signature = await wallet.sendTransaction(transaction, connection);
        await connection.confirmTransaction(signature, "confirmed");
        await refresh();
      } catch (err) {
        setError(friendly(err));
      } finally {
        setBusy(false);
      }
    },
    [connection, owner, refresh, wallet],
  );

  const cancelPlan = useCallback(
    async (plan: Plan) => {
      if (!owner || !wallet.sendTransaction) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const program = getProgram(
          connection,
          wallet as unknown as AnchorProvider["wallet"],
        );
        const transaction = await buildCancelPlanTransaction({
          program,
          owner,
          planAddress: new PublicKey(plan.address),
        });
        const signature = await wallet.sendTransaction(transaction, connection);
        await connection.confirmTransaction(signature, "confirmed");
        await refresh();
      } catch (err) {
        setError(friendly(err));
      } finally {
        setBusy(false);
      }
    },
    [connection, owner, refresh, wallet],
  );

  const resumePlan = useCallback(
    async (plan: Plan) => {
      if (!owner || !wallet.sendTransaction) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const transaction = await buildResumePlanTransaction({
          owner,
          planAddress: new PublicKey(plan.address),
          amount: plan.amount,
        });
        const signature = await wallet.sendTransaction(transaction, connection);
        await connection.confirmTransaction(signature, "confirmed");
        await refresh();
      } catch (err) {
        setError(friendly(err));
      } finally {
        setBusy(false);
      }
    },
    [connection, owner, refresh, wallet],
  );

  const activePlan = plans.find((plan) => plan.active) ?? null;
  const activePlanUnfunded =
    activePlan !== null && delegate !== activePlan.address;

  return {
    activePlanUnfunded,
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
  const message = err instanceof Error ? err.message : String(err);
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
