"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { ADDRESS_BOOK, AMOUNT_PRESETS } from "@/lib/config";
import { Plan } from "@/lib/paritas";
import { useSavings } from "@/lib/useSavings";
import {
  cadencePhrase,
  formatMoney,
  formatMoneyShort,
  formatShares,
  sharesToNumber,
  whenNext,
} from "@/lib/format";
import { Motion, SPRING_SOFT, ShareCounter } from "./motion";

const ASSET = ADDRESS_BOOK.vault.displayName;
const MONEY_DECIMALS = ADDRESS_BOOK.payment.decimals;
const SHARE_DECIMALS = ADDRESS_BOOK.vault.receiptDecimals;

export function Screens() {
  const { connected } = useWallet();
  const savings = useSavings();

  const screen = !connected ? "welcome" : savings.loading ? "loading" : "home";

  return (
    <Motion>
      {/* mode="wait" so the outgoing screen is gone before the next arrives.
          Crossfading two full screens on a 390px viewport reads as a glitch,
          not a transition. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={screen}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={SPRING_SOFT}
        >
          {screen === "welcome" ? (
            <Welcome />
          ) : screen === "loading" ? (
            <Loading />
          ) : (
            <Home savings={savings} />
          )}
        </motion.div>
      </AnimatePresence>
    </Motion>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col px-5 pb-10 pt-8">
      {children}
    </main>
  );
}

function Welcome() {
  const { setVisible } = useWalletModal();
  return (
    <Shell>
      <div className="flex flex-1 flex-col justify-center">
        <p className="text-sm font-medium tracking-wide text-muted">INVESTIRE</p>
        <h1 className="mt-4 text-[2.5rem] font-semibold leading-[1.1] tracking-tight">
          Save a little
          <br />
          every week.
          <br />
          Own {ASSET}.
        </h1>
        <p className="mt-5 text-[17px] leading-relaxed text-muted">
          Set it once. Five dollars a week buys you a slice of a share, and the
          slices add up.
        </p>
      </div>
      <motion.button
        whileTap={{ scale: 0.98 }}
        onClick={() => setVisible(true)}
        className="w-full rounded-2xl bg-ink py-4 text-[17px] font-semibold text-paper active:opacity-90"
      >
        Get started
      </motion.button>
    </Shell>
  );
}

function Loading() {
  return (
    <Shell>
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted">One moment</p>
      </div>
    </Shell>
  );
}

function Home({ savings }: { savings: ReturnType<typeof useSavings> }) {
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState(false);
  const { activePlan, holdings, fundingBlock, error, busy, activePlanUnfunded } =
    savings;

  if (creating) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={SPRING_SOFT}
      >
        <CreatePlan
          savings={savings}
          onDone={() => setCreating(false)}
          onCancel={() => setCreating(false)}
        />
      </motion.div>
    );
  }

  return (
    <Shell>
      <Hero shares={holdings?.shares ?? 0n} invested={holdings?.invested ?? 0n} />

      {activePlan ? (
        <PlanCard
          plan={activePlan}
          expanded={detail}
          unfunded={activePlanUnfunded}
          onToggle={() => setDetail((open) => !open)}
          onCancel={() => savings.cancelPlan(activePlan)}
          onResume={() => savings.resumePlan(activePlan)}
          busy={busy}
        />
      ) : (
        <StartCard
          cash={holdings?.cash ?? 0n}
          block={fundingBlock}
          onStart={() => setCreating(true)}
        />
      )}

      <AnimatePresence>
        {error ? (
          <motion.p
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-4 rounded-xl bg-accentSoft px-4 py-3 text-[15px] text-ink"
          >
            {error}
          </motion.p>
        ) : null}
      </AnimatePresence>

      <Footer cash={holdings?.cash ?? 0n} />
    </Shell>
  );
}

/**
 * Shares first, at the size of a headline. Dollars second, small, and
 * deliberately labelled as what was put in rather than what it is worth today:
 * a savings balance that lurches around with the market is the thing this
 * product exists not to be.
 */
function Hero({ shares, invested }: { shares: bigint; invested: bigint }) {
  return (
    <section className="pb-8 pt-6">
      <p className="text-[13px] font-medium uppercase tracking-[0.14em] text-muted">
        Shares owned
      </p>
      <p className="tabular mt-2 text-[4rem] font-semibold leading-none tracking-tight">
        <ShareCounter value={sharesToNumber(shares, SHARE_DECIMALS)} />
      </p>
      <p className="mt-3 text-[15px] text-muted">
        of {ASSET} &middot; {formatMoney(invested, MONEY_DECIMALS)} invested
      </p>
    </section>
  );
}

function PlanCard({
  plan,
  expanded,
  unfunded,
  onToggle,
  onCancel,
  onResume,
  busy,
}: {
  plan: Plan;
  expanded: boolean;
  unfunded: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onResume: () => void;
  busy: boolean;
}) {
  return (
    // `layout` is what makes this a card growing into a detail view rather
    // than a card being replaced by a taller one. The height animates, the
    // text above it holds still, and nothing below it jumps.
    <motion.section
      layout
      transition={SPRING_SOFT}
      className="overflow-hidden rounded-3xl border border-line bg-white/60 p-5"
    >
      <button onClick={onToggle} className="w-full text-left">
        <p className="text-[19px] font-medium leading-snug">
          You save {formatMoneyShort(plan.amount, MONEY_DECIMALS)}{" "}
          {cadencePhrase(plan.cadenceSeconds, plan.nextDueTs)}.
        </p>
        <p className="mt-2 text-[15px] text-muted">
          {unfunded ? "Paused" : `Next one ${whenNext(plan.nextDueTs)}`}
        </p>
      </button>

      {unfunded ? (
        <motion.div layout className="mt-4 rounded-2xl bg-accentSoft p-4">
          <p className="text-[15px] leading-relaxed text-ink">
            This plan cannot buy right now, because permission to spend from
            your account was removed.
          </p>
          <button
            onClick={onResume}
            disabled={busy}
            className="mt-3 w-full rounded-xl bg-accent py-3 text-[15px] font-semibold text-white active:opacity-90 disabled:opacity-50"
          >
            {busy ? "Starting again" : "Start it again"}
          </button>
        </motion.div>
      ) : null}

      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="detail"
            layout
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={SPRING_SOFT}
            className="mt-5 border-t border-line pt-5"
          >
          <Row label="Bought so far" value={`${plan.executions} times`} />
          <Row
            label="Put in"
            value={formatMoney(plan.investedTotal, MONEY_DECIMALS)}
          />
          <Row
            label="Shares from this plan"
            value={formatShares(plan.sharesTotal, SHARE_DECIMALS)}
          />
          <button
            onClick={onCancel}
            disabled={busy}
            className="mt-5 w-full rounded-2xl border border-line py-3.5 text-[16px] font-medium text-muted active:bg-line/40 disabled:opacity-50"
          >
            {busy ? "Stopping" : "Stop saving"}
          </button>
            <p className="mt-3 text-center text-[13px] leading-relaxed text-muted">
              Your shares stay yours. Stopping only ends future buys.
            </p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between py-2">
      <span className="text-[15px] text-muted">{label}</span>
      <span className="tabular text-[15px] font-medium">{value}</span>
    </div>
  );
}

function StartCard({
  cash,
  block,
  onStart,
}: {
  cash: bigint;
  block: ReturnType<typeof useSavings>["fundingBlock"];
  onStart: () => void;
}) {
  if (block.kind === "foreign-delegate") {
    return (
      <section className="rounded-3xl border border-line bg-white/60 p-5">
        <p className="text-[17px] font-medium">Your account is already spoken for</p>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">
          Something else has permission to spend from your dollar account.
          Starting a plan here would take that permission away from it, so we
          have left it alone.
        </p>
      </section>
    );
  }

  if (cash === 0n) {
    return (
      <section className="rounded-3xl border border-line bg-white/60 p-5">
        <p className="text-[17px] font-medium">Add some dollars to begin</p>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">
          Your plan buys with the dollars in your account. Once there are some
          there, you can start saving.
        </p>
      </section>
    );
  }

  return (
    <motion.button
      whileTap={{ scale: 0.98 }}
      onClick={onStart}
      className="w-full rounded-2xl bg-ink py-4 text-[17px] font-semibold text-paper active:opacity-90"
    >
      Start saving
    </motion.button>
  );
}

/**
 * Tap one got here. Tap two picks the amount. Tap three confirms, and the
 * wallet asks once, because creating and funding a plan is a single
 * transaction.
 */
function CreatePlan({
  savings,
  onDone,
  onCancel,
}: {
  savings: ReturnType<typeof useSavings>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState<number>(AMOUNT_PRESETS[0]);
  const raw = BigInt(Math.round(amount * 10 ** MONEY_DECIMALS));
  const weekday = new Date().toLocaleDateString(undefined, { weekday: "long" });

  return (
    <Shell>
      <button
        onClick={onCancel}
        className="-ml-1 self-start px-1 py-2 text-[15px] text-muted"
      >
        Back
      </button>

      <div className="flex-1 pt-6">
        <h2 className="text-[2rem] font-semibold leading-tight tracking-tight">
          How much,
          <br />
          every week?
        </h2>

        <div className="mt-8 grid grid-cols-3 gap-3">
          {AMOUNT_PRESETS.map((preset) => {
            const selected = preset === amount;
            return (
              <motion.button
                key={preset}
                onClick={() => setAmount(preset)}
                whileTap={{ scale: 0.96 }}
                className={[
                  "tabular relative rounded-2xl py-5 text-[22px] font-semibold",
                  selected ? "text-paper" : "border border-line bg-white/60 text-ink",
                ].join(" ")}
              >
                {/* One pill shared between the three chips via layoutId, so
                    selection slides across rather than blinking on and off. */}
                {selected ? (
                  <motion.span
                    layoutId="amount-pill"
                    className="absolute inset-0 rounded-2xl bg-ink"
                  />
                ) : null}
                <span className="relative">${preset}</span>
              </motion.button>
            );
          })}
        </div>

        <p className="mt-6 text-[15px] leading-relaxed text-muted">
          Every {weekday}, {formatMoneyShort(raw, MONEY_DECIMALS)} buys you a
          slice of {ASSET}. Stop whenever you like.
        </p>
      </div>

      <motion.button
        whileTap={{ scale: 0.98 }}
        onClick={async () => {
          await savings.createPlan(raw);
          onDone();
        }}
        disabled={savings.busy}
        className="w-full rounded-2xl bg-ink py-4 text-[17px] font-semibold text-paper active:opacity-90 disabled:opacity-50"
      >
        {savings.busy
          ? "Setting up"
          : `Save ${formatMoneyShort(raw, MONEY_DECIMALS)} every week`}
      </motion.button>

      {savings.error ? (
        <p className="mt-4 text-center text-[15px] text-ink">{savings.error}</p>
      ) : null}
    </Shell>
  );
}

function Footer({ cash }: { cash: bigint }) {
  return (
    <footer className="mt-auto pt-10">
      <p className="text-center text-[13px] text-muted">
        {formatMoney(cash, MONEY_DECIMALS)} ready to save
      </p>
    </footer>
  );
}
