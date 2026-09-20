"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import {
  ADDRESS_BOOK,
  AMOUNT_PRESETS,
  ASSETS,
  CADENCES,
  VaultEntry,
  WEEK_SECONDS,
  assetBySymbol,
} from "@/lib/config";
import {
  Funding,
  PROGRAM_ID,
  PayoutSource,
  Plan,
  RUNS_FUNDED,
  loadPayoutSources,
  loadVaultEquity,
  payoutPerWrapper,
  planPayout,
  planProblem,
  holdingInShares,
  sharesPerWholeToken,
} from "@/lib/paritas";
import {
  CASH_OUT_CLOSED,
  CashOutQuote,
  Prices,
  quoteCashOut,
  useSavings,
} from "@/lib/useSavings";
import { Portfolio, buildPortfolio, computeStreak } from "@/lib/portfolio";
import {
  allowanceReach,
  cadencePhrase,
  changePhrase,
  exactAmount,
  relativePercent,
  formatMoney,
  formatMoneyShort,
  formatShares,
  moneyInput,
  parseMoney,
  parseShares,
  priceAge,
  sharesToNumber,
  shortDate,
  streakPhrase,
  whenNext,
} from "@/lib/format";
import { Motion, SPRING_SOFT, ShareCounter } from "./motion";

const MONEY_DECIMALS = ADDRESS_BOOK.payment.decimals;

type Savings = ReturnType<typeof useSavings>;

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

/**
 * The product is not one company. It names what is live today, from the
 * address book, and says more is coming without saying what, because a list
 * of assets we do not have would be a promise nobody has made.
 */
function Welcome() {
  const { setVisible } = useWalletModal();
  return (
    <Shell>
      <div className="flex flex-1 flex-col justify-center">
        <p className="text-sm font-medium tracking-wide text-muted">INVESTIRE</p>
        <h1 className="mt-4 text-[2.5rem] font-semibold leading-[1.1] tracking-tight">
          Own a piece of the companies you believe in.
        </h1>
        <p className="mt-5 text-[17px] leading-relaxed text-muted">
          Set it once. A few dollars a day, a week or a month buys you a slice
          of a share, and the slices add up.
        </p>

        <ul className="mt-8 space-y-2">
          {ASSETS.map((asset) => (
            <li
              key={asset.symbol}
              className="flex items-baseline justify-between rounded-2xl border border-line bg-white/60 px-4 py-3"
            >
              <span className="text-[17px] font-medium">{asset.displayName}</span>
              <span className="text-[14px] text-muted">{asset.description}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[14px] text-muted">More are on the way.</p>
      </div>
      <motion.button
        whileTap={{ scale: 0.98 }}
        onClick={() => setVisible(true)}
        className="mt-8 w-full rounded-2xl bg-ink py-4 text-[17px] font-semibold text-paper active:opacity-90"
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

type Overlay =
  | { kind: "create" }
  | { kind: "change"; plan: Plan }
  | { kind: "withdraw" }
  | { kind: "hood" }
  | null;

function Home({ savings }: { savings: Savings }) {
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [detail, setDetail] = useState(false);
  const { activePlan, holdings, fundingBlock, error, busy, activePlanUnfunded } =
    savings;

  const portfolio = useMemo(
    () =>
      buildPortfolio({
        assets: ASSETS,
        shares: holdings?.shares ?? {},
        plans: savings.plans,
        quotes: savings.prices.status === "ready" ? savings.prices.quotes : null,
        moneyDecimals: MONEY_DECIMALS,
      }),
    [holdings, savings.plans, savings.prices],
  );
  const streak = useMemo(
    () =>
      computeStreak(savings.executions, activePlan, Math.floor(Date.now() / 1000)),
    [savings.executions, activePlan],
  );

  if (overlay) {
    const close = () => setOverlay(null);
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={SPRING_SOFT}
      >
        {overlay.kind === "hood" ? (
          <UnderTheHood onClose={close} />
        ) : overlay.kind === "withdraw" ? (
          <WithdrawForm savings={savings} onClose={close} />
        ) : (
          <PlanForm
            savings={savings}
            plan={overlay.kind === "change" ? overlay.plan : null}
            onClose={close}
          />
        )}
      </motion.div>
    );
  }

  const open = (next: Overlay) => {
    savings.clearError();
    setOverlay(next);
  };

  const shares = holdings?.shares ?? {};
  const anyShares = Object.values(shares).some((amount) => amount > 0n);

  return (
    <Shell>
      <Hero
        shares={shares}
        planAsset={activePlan?.asset ?? null}
        streak={streakPhrase(streak.count, streak.cadenceSeconds)}
        onWithdraw={anyShares ? () => open({ kind: "withdraw" }) : null}
      />

      {anyShares ? <ValueCard portfolio={portfolio} prices={savings.prices} /> : null}

      {activePlan ? (
        <PlanCard
          plan={activePlan}
          plans={savings.plans}
          funding={savings.funding}
          shares={shares[activePlan.asset] ?? 0n}
          expanded={detail}
          unfunded={activePlanUnfunded}
          onToggle={() => setDetail((isOpen) => !isOpen)}
          onChange={() => open({ kind: "change", plan: activePlan })}
          onCancel={() => savings.cancelPlan(activePlan)}
          onResume={() => savings.resumePlan(activePlan)}
          busy={busy}
        />
      ) : (
        <StartCard
          cash={holdings?.cash ?? 0n}
          block={fundingBlock}
          onStart={() => open({ kind: "create" })}
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

      <Footer cash={holdings?.cash ?? 0n} onHood={() => open({ kind: "hood" })} />
    </Shell>
  );
}

/**
 * Shares first, at the size of a headline, one line per asset because a share
 * of NVIDIA and a share of the S&P 500 do not add up to anything. The share
 * count is the hero because it only moves when the saver acts: it goes up with
 * every buy and never with the market, so on a red day the biggest number on
 * the screen is still one that grew. Money lives in the card below it.
 */
function Hero({
  shares,
  planAsset,
  streak,
  onWithdraw,
}: {
  shares: Record<string, bigint>;
  planAsset: string | null;
  streak: string | null;
  onWithdraw: (() => void) | null;
}) {
  const shown = ASSETS.filter(
    (asset) => (shares[asset.symbol] ?? 0n) > 0n || asset.symbol === planAsset,
  );
  const single = shown.length <= 1;

  return (
    <section className="pb-8 pt-6">
      <div className="flex items-baseline justify-between">
        <p className="text-[13px] font-medium uppercase tracking-[0.14em] text-muted">
          Shares owned
        </p>
        {onWithdraw ? (
          <button
            onClick={onWithdraw}
            className="-mr-1 px-1 py-1 text-[15px] font-medium text-accent"
          >
            Take out
          </button>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <p className="tabular mt-2 text-[4rem] font-semibold leading-none tracking-tight">
          <ShareCounter value={0} />
        </p>
      ) : (
        shown.map((asset) => (
          <div key={asset.symbol} className={single ? "" : "mt-3"}>
            <p
              className={[
                "tabular mt-2 font-semibold leading-none tracking-tight",
                single ? "text-[4rem]" : "text-[2.75rem]",
              ].join(" ")}
            >
              <ShareCounter
                value={sharesToNumber(shares[asset.symbol] ?? 0n, asset.receiptDecimals)}
              />
            </p>
            <p className="mt-1 text-[15px] text-muted">of {asset.displayName}</p>
          </div>
        ))
      )}

      {streak ? (
        <motion.p
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={SPRING_SOFT}
          className="tabular mt-4 inline-block rounded-full bg-accentSoft px-3 py-1 text-[13px] font-medium text-accent"
        >
          {streak}
        </motion.p>
      ) : null}
    </section>
  );
}

/**
 * Money, secondary to shares and honest about both directions.
 *
 * Nothing here changes colour with the market. Up and down are words set in
 * the same ink, the card looks identical on a green day and a red one, and
 * the one line of reassurance is always there rather than appearing when
 * things fall, which would be its own kind of alarm. Loss is information
 * here, not an error state.
 *
 * Every figure is said with its age. Equity prices stop at the close, so from
 * Friday evening to Monday morning "worth today" is worth at Friday's close,
 * and the card says so.
 */
function ValueCard({ portfolio, prices }: { portfolio: Portfolio; prices: Prices }) {
  const held = portfolio.assets.filter((position) => position.shares > 0n);
  const withoutCost = held.filter((position) => position.sharesWithoutCost > 0n);

  return (
    <motion.section
      layout
      transition={SPRING_SOFT}
      className="mb-4 rounded-3xl border border-line bg-white/60 p-5"
    >
      <p className="text-[13px] font-medium uppercase tracking-[0.14em] text-muted">
        Worth today
      </p>

      {portfolio.value !== null ? (
        <>
          <p className="tabular mt-1 text-[28px] font-semibold leading-tight">
            {formatMoney(portfolio.value, MONEY_DECIMALS)}
          </p>
          <p className="tabular mt-1 text-[15px] text-ink">
            {portfolio.gain !== null
              ? changePhrase(portfolio.gain, portfolio.gainPercent, MONEY_DECIMALS)
              : null}
            <span className="text-muted">
              {" "}on {formatMoney(portfolio.invested, MONEY_DECIMALS)} put in
            </span>
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 text-[15px] leading-relaxed text-muted">
            {prices.status === "loading"
              ? "Checking today's prices"
              : "Today's value isn't available right now."}
          </p>
          <p className="tabular mt-1 text-[15px] text-ink">
            {formatMoney(portfolio.invested, MONEY_DECIMALS)}{" "}
            <span className="text-muted">put in</span>
          </p>
        </>
      )}

      <div className="mt-4 border-t border-line pt-3">
        {held.map((position) => {
          const asset = assetBySymbol(position.symbol);
          return (
            <div key={position.symbol} className="py-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[15px] font-medium">{asset.displayName}</span>
                <span className="tabular text-[15px] font-medium">
                  {position.value !== null
                    ? formatMoney(position.value, MONEY_DECIMALS)
                    : `${formatShares(position.shares, asset.receiptDecimals)} shares`}
                </span>
              </div>
              <div className="tabular mt-0.5 flex items-baseline justify-between gap-3 text-[13px] text-muted">
                <span>
                  {position.value !== null
                    ? `${formatShares(position.shares, asset.receiptDecimals)} shares \u00b7 `
                    : ""}
                  {formatMoney(position.invested, MONEY_DECIMALS)} put in
                </span>
                {position.gain !== null ? (
                  <span className="text-ink">
                    {changePhrase(position.gain, position.gainPercent, MONEY_DECIMALS)}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {withoutCost.length > 0 && portfolio.value !== null ? (
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          Includes{" "}
          {withoutCost
            .map(
              (position) =>
                `${formatShares(
                  position.sharesWithoutCost,
                  assetBySymbol(position.symbol).receiptDecimals,
                )} shares of ${assetBySymbol(position.symbol).displayName}`,
            )
            .join(" and ")}{" "}
          added outside your plans, so what they cost is not known and they are
          left out of the change.
        </p>
      ) : null}

      <p className="mt-3 text-[13px] leading-relaxed text-muted">
        {portfolio.pricedAt !== null ? `${priceAge(portfolio.pricedAt)}. ` : ""}
        Value moves with the market. Your shares don&rsquo;t.
      </p>
    </motion.section>
  );
}

function PlanCard({
  plan,
  plans,
  funding,
  shares,
  expanded,
  unfunded,
  onToggle,
  onChange,
  onCancel,
  onResume,
  busy,
}: {
  plan: Plan;
  plans: Plan[];
  funding: Funding;
  shares: bigint;
  expanded: boolean;
  unfunded: boolean;
  onToggle: () => void;
  onChange: () => void;
  onCancel: () => void;
  onResume: () => void;
  busy: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const asset = assetBySymbol(plan.asset);

  // Changing a plan replaces it with a new one, so this plan's own counters
  // start again at zero. The history a saver means by "so far" is every plan
  // they have had, the same basis the hero's invested figure uses.
  const lifetime = plans.reduce(
    (sum, each) => ({
      buys: sum.buys + each.executions,
      invested: sum.invested + each.investedTotal,
    }),
    { buys: 0, invested: 0n },
  );

  // The allowance only counts toward this plan when this plan holds it.
  const allowance = funding.delegate === plan.address ? funding.delegatedAmount : 0n;
  const usedUp = funding.delegate === plan.address && allowance < plan.amount;
  const sentence = `${formatMoneyShort(plan.amount, MONEY_DECIMALS)} ${cadencePhrase(
    plan.cadenceSeconds,
    plan.nextDueTs,
  )}`;

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
          You save {sentence} into {asset.displayName}.
        </p>
        <p className="mt-2 text-[15px] text-muted">
          {unfunded ? "Paused" : `Next one ${whenNext(plan.nextDueTs)}`}
          <span aria-hidden> &middot; </span>
          {expanded ? "Less" : "Details"}
        </p>
      </button>

      {unfunded ? (
        <motion.div layout className="mt-4 rounded-2xl bg-accentSoft p-4">
          <p className="text-[15px] leading-relaxed text-ink">
            {usedUp
              ? "This plan has used up the amount you allowed it, so it has stopped buying."
              : "This plan cannot buy right now, because permission to spend from your account was removed."}
          </p>
          <button
            onClick={onResume}
            disabled={busy}
            className="mt-3 w-full rounded-xl bg-accent py-3 text-[15px] font-semibold text-white active:opacity-90 disabled:opacity-50"
          >
            {busy
              ? "Starting again"
              : `Allow ${RUNS_FUNDED} more buys, ${formatMoney(
                  plan.amount * BigInt(RUNS_FUNDED),
                  MONEY_DECIMALS,
                )}`}
          </button>
        </motion.div>
      ) : (
        <Allowance plan={plan} allowance={allowance} />
      )}

      {/* Stop sits on the card itself, never behind the detail view: anything
          that moves money on a schedule is always in plain sight of the way
          to stop it. The confirmation is soft, one more tap, and exists only
          so a stray thumb does not end a habit. Nothing is locked. */}
      <AnimatePresence mode="wait" initial={false}>
        {confirming ? (
          <motion.div
            key="confirm"
            layout
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={SPRING_SOFT}
            className="mt-4 rounded-2xl border border-line p-4"
          >
            <p className="text-[15px] leading-relaxed text-ink">
              Stop saving {sentence}? You keep your{" "}
              {formatShares(shares, asset.receiptDecimals)} shares, the
              permission to spend is removed straight away, and you can start
              again whenever you like.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <button
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="rounded-xl border border-line py-3 text-[15px] font-medium text-ink active:bg-line/40 disabled:opacity-50"
              >
                Keep saving
              </button>
              <button
                onClick={onCancel}
                disabled={busy}
                className="rounded-xl bg-ink py-3 text-[15px] font-semibold text-paper active:opacity-90 disabled:opacity-50"
              >
                {busy ? "Stopping" : "Stop"}
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="actions"
            layout
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="mt-4 grid grid-cols-2 gap-3"
          >
            <button
              onClick={onChange}
              disabled={busy}
              className="rounded-2xl border border-line py-3 text-[15px] font-medium text-ink active:bg-line/40 disabled:opacity-50"
            >
              Change
            </button>
            <button
              onClick={() => setConfirming(true)}
              disabled={busy}
              className="rounded-2xl border border-line py-3 text-[15px] font-medium text-ink active:bg-line/40 disabled:opacity-50"
            >
              Stop saving
            </button>
          </motion.div>
        )}
      </AnimatePresence>

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
            <Row label="Bought so far" value={`${lifetime.buys} times`} />
            <Row label="Put in" value={formatMoney(lifetime.invested, MONEY_DECIMALS)} />
            <Row
              label={`Shares of ${asset.displayName}`}
              value={formatShares(shares, asset.receiptDecimals)}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.section>
  );
}

/**
 * What the app can take, stated as money and as buys. The dollar figure is the
 * hard ceiling: it is the approval on the saver's account, read from chain, and
 * nothing can spend past it. The buys and the date are what that ceiling means
 * at this plan's amount and pace.
 */
function Allowance({ plan, allowance }: { plan: Plan; allowance: bigint }) {
  const { buys, lastTs } = allowanceReach({
    allowance,
    amount: plan.amount,
    cadenceSeconds: plan.cadenceSeconds,
    nextDueTs: plan.nextDueTs,
  });

  return (
    <motion.div layout className="mt-4 rounded-2xl bg-paper p-4">
      <p className="text-[13px] font-medium uppercase tracking-[0.14em] text-muted">
        Allowed to take
      </p>
      <p className="tabular mt-1 text-[24px] font-semibold">
        {formatMoney(allowance, MONEY_DECIMALS)}
      </p>
      <p className="mt-1 text-[15px] leading-relaxed text-muted">
        {buys === 1 ? "1 more buy" : `${buys} more buys`} of{" "}
        {formatMoneyShort(plan.amount, MONEY_DECIMALS)}
        {lastTs ? `, the last on ${shortDate(lastTs)}` : ""}. Nothing more
        leaves your account without you allowing it.
      </p>
    </motion.div>
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
  block: Savings["fundingBlock"];
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
          Your plan buys with the dollars in your account. This runs on
          Solana&rsquo;s test network, so the money is test money and the
          shares are not real.
        </p>
        {/* Without these a fresh wallet has nowhere to go: no dollars to save
            and no SOL to pay the fee with. */}
        <div className="mt-4 grid gap-2">
          <a
            href="https://faucet.circle.com"
            target="_blank"
            rel="noreferrer"
            className="rounded-xl bg-ink px-4 py-3 text-center text-[15px] font-semibold text-paper active:opacity-90"
          >
            Get test dollars
          </a>
          <a
            href="https://faucet.solana.com"
            target="_blank"
            rel="noreferrer"
            className="rounded-xl border border-line px-4 py-3 text-center text-[15px] font-medium text-ink active:bg-line/40"
          >
            Get test SOL, for fees
          </a>
        </div>
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
 * Two assets side by side. Only displayName and description ever render: the
 * picker chooses a vault, and the wrappers inside it are not the saver's
 * concern.
 */
function AssetPicker({
  value,
  onChange,
  options = ASSETS,
  caption,
}: {
  value: string;
  onChange: (symbol: string) => void;
  options?: VaultEntry[];
  caption?: (asset: VaultEntry) => string;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {options.map((asset) => {
        const selected = asset.symbol === value;
        return (
          <motion.button
            key={asset.symbol}
            onClick={() => onChange(asset.symbol)}
            whileTap={{ scale: 0.97 }}
            className={[
              "relative rounded-2xl px-4 py-3.5 text-left",
              selected ? "text-paper" : "border border-line bg-white/60 text-ink",
            ].join(" ")}
          >
            {selected ? (
              <motion.span
                layoutId="asset-pill"
                className="absolute inset-0 rounded-2xl bg-ink"
              />
            ) : null}
            <span className="relative block text-[17px] font-semibold">
              {asset.displayName}
            </span>
            <span
              className={[
                "relative mt-0.5 block text-[13px] leading-snug",
                selected ? "text-paper/70" : "text-muted",
              ].join(" ")}
            >
              {caption ? caption(asset) : asset.description}
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}

/**
 * Starting a plan and changing one are the same screen: what to own, an
 * amount, a pace, and a plain statement of what that allows the app to take.
 * The wallet asks once, because the whole of it is a single transaction either
 * way.
 */
function PlanForm({
  savings,
  plan,
  onClose,
}: {
  savings: Savings;
  plan: Plan | null;
  onClose: () => void;
}) {
  const [assetSymbol, setAssetSymbol] = useState(plan?.asset ?? ASSETS[0].symbol);
  const [amountText, setAmountText] = useState(
    plan ? moneyInput(plan.amount, MONEY_DECIMALS) : String(AMOUNT_PRESETS[0]),
  );
  // Whether the amount came from the field rather than a chip. Tracked rather
  // than inferred, so typing "5" keeps the field showing 5 instead of handing
  // the value to the $5 chip mid keystroke.
  const [typed, setTyped] = useState(
    plan !== null &&
      !AMOUNT_PRESETS.some(
        (preset) => BigInt(preset) * 10n ** BigInt(MONEY_DECIMALS) === plan.amount,
      ),
  );
  const [cadenceSeconds, setCadenceSeconds] = useState<number>(
    plan?.cadenceSeconds ?? WEEK_SECONDS,
  );

  const asset = assetBySymbol(assetSymbol);
  const amount = parseMoney(amountText, MONEY_DECIMALS);
  const cash = savings.holdings?.cash ?? 0n;
  const limits = savings.limits?.[asset.symbol] ?? null;
  const problem = limits
    ? planProblem({
        amount,
        cadenceSeconds,
        limits,
        cash,
        moneyDecimals: MONEY_DECIMALS,
      })
    : null;
  const unchanged =
    plan !== null &&
    amount === plan.amount &&
    cadenceSeconds === plan.cadenceSeconds &&
    assetSymbol === plan.asset;
  const ready = limits !== null && problem === null && !unchanged;

  // A plan kept on the same pace keeps its day, so the sentence names it; a new
  // or re-paced one starts from today.
  const firstTs =
    plan && cadenceSeconds === plan.cadenceSeconds
      ? plan.nextDueTs
      : Math.floor(Date.now() / 1000);
  const rhythm = cadencePhrase(cadenceSeconds, firstTs);
  const presetSelected = !typed;

  const submit = async () => {
    if (!ready || amount === null) {
      return;
    }
    const landed = plan
      ? await savings.changePlan(plan, asset, amount, cadenceSeconds)
      : await savings.createPlan(asset, amount, cadenceSeconds);
    if (landed) {
      onClose();
    }
  };

  return (
    <Shell>
      <button
        onClick={onClose}
        className="-ml-1 self-start px-1 py-2 text-[15px] text-muted"
      >
        Back
      </button>

      <div className="flex-1 pt-6">
        <h2 className="text-[2rem] font-semibold leading-tight tracking-tight">
          {plan ? "Change your plan" : (
            <>
              What, how much,
              <br />
              how often?
            </>
          )}
        </h2>

        <div className="mt-8">
          <AssetPicker value={assetSymbol} onChange={setAssetSymbol} />
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 rounded-2xl border border-line bg-white/60 p-1">
          {CADENCES.map((option) => {
            const selected = option.seconds === cadenceSeconds;
            return (
              <button
                key={option.label}
                onClick={() => setCadenceSeconds(option.seconds)}
                className={[
                  "relative rounded-xl py-2.5 text-[15px] font-medium",
                  selected ? "text-paper" : "text-ink",
                ].join(" ")}
              >
                {selected ? (
                  <motion.span
                    layoutId="cadence-pill"
                    className="absolute inset-0 rounded-xl bg-ink"
                  />
                ) : null}
                <span className="relative">{option.label}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-4 grid grid-cols-3 gap-3">
          {AMOUNT_PRESETS.map((preset) => {
            const selected =
              presetSelected && BigInt(preset) * 10n ** BigInt(MONEY_DECIMALS) === amount;
            return (
              <motion.button
                key={preset}
                onClick={() => {
                  setTyped(false);
                  setAmountText(String(preset));
                }}
                whileTap={{ scale: 0.96 }}
                className={[
                  "tabular relative rounded-2xl py-5 text-[22px] font-semibold",
                  selected ? "text-paper" : "border border-line bg-white/60 text-ink",
                ].join(" ")}
              >
                {/* One pill shared between the chips via layoutId, so
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

        <label
          className={[
            "mt-3 flex items-center rounded-2xl border bg-white/60 px-4 py-3.5",
            presetSelected ? "border-line" : "border-ink",
          ].join(" ")}
        >
          <span className="text-[15px] text-muted">Other amount</span>
          <span className="ml-auto text-[20px] font-semibold text-muted">$</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            value={typed ? amountText : ""}
            placeholder="0.00"
            onFocus={() => {
              if (!typed) {
                setTyped(true);
                setAmountText("");
              }
            }}
            onChange={(event) => setAmountText(event.target.value)}
            className="tabular w-24 bg-transparent text-right text-[20px] font-semibold text-ink outline-none placeholder:text-line"
          />
        </label>

        {amount !== null && problem === null ? (
          <>
            <p className="mt-6 text-[15px] leading-relaxed text-muted">
              {capitalise(rhythm)}, {formatMoneyShort(amount, MONEY_DECIMALS)} buys
              you a slice of {asset.displayName}.
            </p>
            <p className="mt-3 rounded-2xl bg-accentSoft px-4 py-3 text-[15px] leading-relaxed text-ink">
              You are allowing up to{" "}
              <span className="tabular font-semibold">
                {formatMoney(amount * BigInt(RUNS_FUNDED), MONEY_DECIMALS)}
              </span>
              , enough for {RUNS_FUNDED} buys. After that the plan pauses until
              you allow more. You can stop it any time.
              {plan ? " This replaces what your current plan was allowed." : ""}
            </p>
          </>
        ) : null}

        {problem && amountText.trim() !== "" ? (
          <p className="mt-6 text-[15px] leading-relaxed text-ink">{problem}</p>
        ) : null}
      </div>

      <motion.button
        whileTap={{ scale: 0.98 }}
        onClick={submit}
        disabled={savings.busy || !ready}
        className="mt-6 w-full rounded-2xl bg-ink py-4 text-[17px] font-semibold text-paper active:opacity-90 disabled:opacity-40"
      >
        {savings.busy
          ? plan
            ? "Saving the change"
            : "Setting up"
          : amount !== null && problem === null
            ? `Save ${formatMoneyShort(amount, MONEY_DECIMALS)} ${rhythm}`
            : "Save"}
      </motion.button>

      {savings.error ? (
        <p className="mt-4 text-center text-[15px] text-ink">{savings.error}</p>
      ) : null}
    </Shell>
  );
}

/**
 * Taking money out, two ways, chosen side by side with what each pays.
 *
 * Shares: the receipts are burned and the shares land in the saver's own
 * wallet, through whichever wrapper the vault can pay from, which is never
 * named. Cash: the same, sold to dollars in the same transaction, landing in
 * the dollar account plans buy from.
 *
 * The amount is always in shares, because that is what the saver has. Each
 * option then shows exactly what it pays: the share count worked out with the
 * program's own integer math, and the dollar figure from the quote the
 * transaction will be built to, with the saver's signature binding it as a
 * minimum.
 */
type Way = "shares" | "cash";

function WithdrawForm({ savings, onClose }: { savings: Savings; onClose: () => void }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const shares = savings.holdings?.shares ?? {};
  const held = ASSETS.filter((asset) => (shares[asset.symbol] ?? 0n) > 0n);

  const [assetSymbol, setAssetSymbol] = useState(
    held[0]?.symbol ?? ASSETS[0].symbol,
  );
  const [text, setText] = useState("");
  const [all, setAll] = useState(false);
  const [way, setWay] = useState<Way>("shares");
  const [sources, setSources] = useState<PayoutSource[] | null>(null);
  const [quote, setQuote] = useState<CashOutQuote | null>(null);
  // Off by default, and not remembered: the advanced view is something a
  // saver opens on purpose each time, never a place they are left in.
  const [advanced, setAdvanced] = useState(false);
  const [chosenMint, setChosenMint] = useState<string | null>(null);

  const asset = assetBySymbol(assetSymbol);
  const owned = shares[asset.symbol] ?? 0n;
  const amount = all ? owned : parseShares(text, asset.receiptDecimals);
  const tooMuch = amount !== null && amount > owned;
  const valid = amount !== null && amount > 0n && !tooMuch;

  useEffect(() => {
    let live = true;
    setSources(null);
    loadPayoutSources(connection, asset)
      .then((loaded) => live && setSources(loaded))
      .catch(() => live && setSources([]));
    return () => {
      live = false;
    };
  }, [connection, asset]);

  // Quoted as the amount settles, not on every keystroke.
  useEffect(() => {
    setQuote(null);
    if (!valid || !publicKey || amount === null) {
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      quoteCashOut(publicKey, asset, amount).then((next) => live && setQuote(next));
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [valid, amount, asset, publicKey]);

  const payout = valid && sources ? planPayout(amount!, sources) : null;

  // The advanced view: every wrapper's payout for the same shares, side by
  // side. Only computed when the saver has asked to see it.
  const perWrapper =
    advanced && valid && sources ? payoutPerWrapper(amount!, sources) : null;
  const silentChoice =
    payout?.kind === "ok" && payout.legs.length === 1
      ? payout.legs[0].source.wrapper.mint
      : perWrapper?.find((row) => row.covered)?.source.wrapper.mint ?? null;
  const chosen =
    perWrapper?.find(
      (row) => row.source.wrapper.mint === (chosenMint ?? silentChoice),
    ) ?? null;
  const advancedShares = advanced && way === "shares" && perWrapper !== null;

  const ready =
    way === "shares"
      ? advancedShares
        ? chosen?.covered === true
        : payout?.kind === "ok"
      : quote?.kind === "ok";

  const submit = async () => {
    if (!ready || amount === null) {
      return;
    }
    const landed =
      way === "shares"
        ? await savings.withdraw(
            asset,
            amount,
            advancedShares ? chosen?.source.wrapper.mint : undefined,
          )
        : quote?.kind === "ok"
          ? await savings.cashOut(asset, amount, quote.paymentOut)
          : false;
    if (landed) {
      onClose();
    }
  };

  const sharesLine = (value: bigint) =>
    `${formatShares(value, asset.receiptDecimals)} shares`;

  const shortLine = (available: bigint, verb: string) =>
    available === 0n
      ? "That is too small. Try a larger amount."
      : `Right now you can ${verb} up to ${sharesLine(available)} at once.`;

  return (
    <Shell>
      <button
        onClick={onClose}
        className="-ml-1 self-start px-1 py-2 text-[15px] text-muted"
      >
        Back
      </button>

      <div className="flex-1 pt-6">
        <h2 className="text-[2rem] font-semibold leading-tight tracking-tight">
          Take money out
        </h2>

        {held.length > 1 ? (
          <div className="mt-8">
            <AssetPicker
              value={assetSymbol}
              onChange={(symbol) => {
                setAssetSymbol(symbol);
                setAll(false);
                setText("");
              }}
              options={held}
              caption={(each) => sharesLine(shares[each.symbol] ?? 0n)}
            />
          </div>
        ) : (
          <p className="mt-4 text-[15px] text-muted">
            You have {sharesLine(owned)} of {asset.displayName}.
          </p>
        )}

        <div className="mt-6 flex gap-3">
          <label
            className={[
              "flex flex-1 items-center rounded-2xl border bg-white/60 px-4 py-3.5",
              all ? "border-line" : "border-ink",
            ].join(" ")}
          >
            <input
              inputMode="decimal"
              autoComplete="off"
              value={all ? formatShares(owned, asset.receiptDecimals) : text}
              placeholder="0.0000"
              onFocus={() => {
                if (all) {
                  setAll(false);
                  setText("");
                }
              }}
              onChange={(event) => setText(event.target.value)}
              className="tabular w-full min-w-0 bg-transparent text-[22px] font-semibold text-ink outline-none placeholder:text-line"
            />
            <span className="ml-2 text-[15px] text-muted">shares</span>
          </label>
          <motion.button
            whileTap={{ scale: 0.96 }}
            onClick={() => setAll(true)}
            className={[
              "rounded-2xl px-5 text-[15px] font-semibold",
              all ? "bg-ink text-paper" : "border border-line bg-white/60 text-ink",
            ].join(" ")}
          >
            All
          </motion.button>
        </div>

        {tooMuch ? (
          <p className="mt-6 text-[15px] leading-relaxed text-ink">
            You have {sharesLine(owned)} of {asset.displayName}, so that is the
            most you can take out.
          </p>
        ) : valid ? (
          <div className="mt-6 space-y-3">
            <WayOption
              selected={way === "shares"}
              onSelect={() => setWay("shares")}
              title="Take the shares"
              detail="Sent to your wallet, to hold yourself."
              outcome={
                !sources
                  ? "Working it out"
                  : advancedShares && chosen
                    ? `${sharesLine(chosen.received)} of ${asset.displayName}`
                    : payout?.kind === "ok"
                    ? `${sharesLine(payout.received)} of ${asset.displayName}`
                    : payout?.kind === "short"
                      ? shortLine(payout.available, "take out")
                      : ""
              }
              available={payout?.kind === "ok"}
            />
            <WayOption
              selected={way === "cash"}
              onSelect={() => setWay("cash")}
              title="Cash out"
              detail="Sold and paid into your dollar account, in one step."
              outcome={
                quote === null
                  ? "Working it out"
                  : quote.kind === "ok"
                    ? formatMoney(quote.paymentOut, MONEY_DECIMALS)
                    : quote.kind === "short"
                      ? shortLine(quote.available, "cash out")
                      : quote.kind === "closed"
                        ? CASH_OUT_CLOSED
                        : "Cash out isn't available right now."
              }
              available={quote?.kind === "ok"}
            />
            {advancedShares && perWrapper ? (
              <WrapperChooser
                rows={perWrapper}
                chosenMint={chosen?.source.wrapper.mint ?? null}
                onChoose={setChosenMint}
                shareDecimals={asset.receiptDecimals}
              />
            ) : null}
            {advanced && way === "cash" ? (
              <p className="px-1 text-[13px] leading-relaxed text-muted">
                Cash out sells through whichever token the vault holds most
                of. The dollars you receive do not depend on which.
              </p>
            ) : null}
            <p className="px-1 text-[13px] leading-relaxed text-muted">
              Either way the shares leave your savings here, and any plan you
              have keeps buying as before.
            </p>
          </div>
        ) : null}

        <label className="mt-6 flex items-center justify-between gap-3 px-1">
          <span className="text-[14px] text-muted">
            Advanced
            {advanced ? (
              <span className="block text-[12px]">Choose which token your shares are paid in.</span>
            ) : null}
          </span>
          <button
            role="switch"
            aria-checked={advanced}
            onClick={() => {
              setAdvanced((on) => !on);
              setChosenMint(null);
            }}
            className={[
              "relative h-6 w-10 shrink-0 rounded-full transition-colors",
              advanced ? "bg-ink" : "bg-line",
            ].join(" ")}
          >
            <motion.span
              layout
              transition={SPRING_SOFT}
              className={[
                "absolute top-0.5 h-5 w-5 rounded-full bg-paper",
                advanced ? "right-0.5" : "left-0.5",
              ].join(" ")}
            />
          </button>
        </label>
      </div>

      <motion.button
        whileTap={{ scale: 0.98 }}
        onClick={submit}
        disabled={savings.busy || !ready}
        className="mt-6 w-full rounded-2xl bg-ink py-4 text-[17px] font-semibold text-paper active:opacity-90 disabled:opacity-40"
      >
        {savings.busy
          ? way === "shares"
            ? "Taking out"
            : "Cashing out"
          : advancedShares && chosen?.covered
            ? `Take ${exactAmount(chosen.rawOut, chosen.source.wrapper.decimals)} ${chosen.source.wrapper.label}`
            : way === "shares" && payout?.kind === "ok"
            ? `Take ${sharesLine(payout.received)}`
            : way === "cash" && quote?.kind === "ok"
              ? `Cash out ${formatMoney(quote.paymentOut, MONEY_DECIMALS)}`
              : "Take money out"}
      </motion.button>

      {savings.error ? (
        <p className="mt-4 text-center text-[15px] text-ink">{savings.error}</p>
      ) : null}
    </Shell>
  );
}

/**
 * The Paritas layer, made visible: the same number of shares, paid out as
 * each wrapper, at each wrapper's own multiplier. The token counts differ,
 * and the difference is exactly the multipliers' drift plus the decimals.
 * Only ever rendered behind the advanced switch.
 */
function WrapperChooser({
  rows,
  chosenMint,
  onChoose,
  shareDecimals,
}: {
  rows: ReturnType<typeof payoutPerWrapper>;
  chosenMint: string | null;
  onChoose: (mint: string) => void;
  shareDecimals: number;
}) {
  // Token counts on a common scale, so two wrappers with different decimals
  // can be subtracted.
  const scale = Math.max(...rows.map((row) => row.source.wrapper.decimals));
  const aligned = (row: (typeof rows)[number]) =>
    row.rawOut * 10n ** BigInt(scale - row.source.wrapper.decimals);
  const [more, fewer] =
    rows.length === 2
      ? [...rows].sort((x, y) => (aligned(x) > aligned(y) ? -1 : 1))
      : [null, null];

  return (
    <div className="rounded-2xl border border-line bg-white/60 p-3">
      {rows.map((row) => {
        const selected = row.source.wrapper.mint === chosenMint;
        const { label, decimals, mint } = row.source.wrapper;
        return (
          <button
            key={mint}
            onClick={() => row.covered && onChoose(mint)}
            disabled={!row.covered}
            className={[
              "w-full rounded-xl px-3 py-2.5 text-left",
              selected ? "bg-accentSoft" : "",
              row.covered ? "" : "opacity-50",
            ].join(" ")}
          >
            <span className="flex items-baseline justify-between gap-3">
              <span className="text-[15px] font-semibold">
                {selected ? "\u25cf " : "\u25cb "}
                {label}
              </span>
              <span className="font-mono text-[14px]">{exactAmount(row.rawOut, decimals)}</span>
            </span>
            <span className="mt-0.5 flex justify-between gap-3 font-mono text-[12px] text-muted">
              <span>{row.rawOut.toLocaleString("en-US")} raw units</span>
              <span>
                {row.covered
                  ? `= ${exactAmount(row.received, shareDecimals)} shares`
                  : `vault holds ${exactAmount(row.source.vaultBalance, decimals)}`}
              </span>
            </span>
          </button>
        );
      })}

      {more && fewer ? (
        <p className="mt-2 px-3 text-[13px] leading-relaxed text-muted">
          Same shares, different token counts. {more.source.wrapper.label} pays{" "}
          <span className="font-mono text-ink">
            {exactAmount(aligned(more) - aligned(fewer), scale)}
          </span>{" "}
          more tokens than {fewer.source.wrapper.label}, because each{" "}
          {more.source.wrapper.label} token carries slightly less of a share
          (multiplier {String(more.source.multiplier)} against{" "}
          {String(fewer.source.multiplier)}). The raw unit counts differ
          by about {Math.round(Number(fewer.rawOut) / Number(more.rawOut) >= 1 ? Number(fewer.rawOut) / Number(more.rawOut) : Number(more.rawOut) / Number(fewer.rawOut))}
          {" "}times as well, which is only the decimals.
        </p>
      ) : null}
    </div>
  );
}

/** One way of taking money out, with what it pays shown before choosing it. */
function WayOption({
  selected,
  onSelect,
  title,
  detail,
  outcome,
  available,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
  outcome: string;
  available: boolean;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.98 }}
      onClick={onSelect}
      className={[
        "relative w-full rounded-2xl px-4 py-3.5 text-left",
        selected ? "text-paper" : "border border-line bg-white/60 text-ink",
      ].join(" ")}
    >
      {selected ? (
        <motion.span layoutId="way-pill" className="absolute inset-0 rounded-2xl bg-ink" />
      ) : null}
      <span className="relative flex items-baseline justify-between gap-3">
        <span className="text-[17px] font-semibold">{title}</span>
        <span
          className={[
            "tabular text-right",
            available ? "text-[17px] font-semibold" : "text-[13px]",
            !available ? (selected ? "text-paper/70" : "text-muted") : "",
          ].join(" ")}
        >
          {outcome}
        </span>
      </span>
      <span
        className={[
          "relative mt-0.5 block text-[13px]",
          selected ? "text-paper/70" : "text-muted",
        ].join(" ")}
      >
        {detail}
      </span>
    </motion.button>
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The way into the under the hood screen sits here, at the very bottom, in
 * the quietest type on the page. One tap for anyone who wants it; easy to
 * never notice for anyone who does not.
 */
function Footer({ cash, onHood }: { cash: bigint; onHood: () => void }) {
  return (
    <footer className="mt-auto pt-10 text-center">
      <p className="text-[13px] text-muted">
        {formatMoney(cash, MONEY_DECIMALS)} ready to save
      </p>
      <button onClick={onHood} className="mt-3 px-2 py-1 text-[13px] text-muted underline decoration-line underline-offset-4">
        Under the hood
      </button>
    </footer>
  );
}

const EXPLORER_CLUSTER =
  ADDRESS_BOOK.cluster === "mainnet-beta" ? "" : `?cluster=${ADDRESS_BOOK.cluster}`;

function explorer(address: string): string {
  return `https://explorer.solana.com/address/${address}${EXPLORER_CLUSTER}`;
}

interface HoodAsset {
  asset: VaultEntry;
  sources: PayoutSource[];
  equity: bigint;
}

/**
 * The one place the app shows what it is built on. Everything the consumer
 * screens deliberately hide is here, read live from chain: which tokens back
 * each asset, their multipliers from mint state, their decimals, what one of
 * each is worth in shares, and why the app's balances are kept in shares and
 * never in token units.
 *
 * Numbers come from the same integer conversions the program runs, so what
 * this screen says one token is worth is what a deposit of it would credit.
 */
function UnderTheHood({ onClose }: { onClose: () => void }) {
  const { connection } = useConnection();
  const [assets, setAssets] = useState<HoodAsset[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all(
      ASSETS.map(async (asset) => ({
        asset,
        sources: await loadPayoutSources(connection, asset),
        equity: await loadVaultEquity(connection, asset),
      })),
    )
      .then((loaded) => live && setAssets(loaded))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [connection]);

  return (
    <Shell>
      <button onClick={onClose} className="-ml-1 self-start px-1 py-2 text-[15px] text-muted">
        Back
      </button>

      <div className="pt-6">
        <h2 className="text-[2rem] font-semibold leading-tight tracking-tight">
          Under the hood
        </h2>
        <p className="mt-4 text-[15px] leading-relaxed text-muted">
          Investire runs on Paritas, a Solana program. A share of NVIDIA is
          issued on chain by more than one provider, as different tokens. They
          stand for the same share, but they are not interchangeable one for
          one, and this is where the difference is handled.
        </p>
      </div>

      {failed ? (
        <p className="mt-8 text-[15px] text-ink">Couldn&rsquo;t read the chain just now. Try again in a moment.</p>
      ) : !assets ? (
        <p className="mt-8 text-[15px] text-muted">Reading the chain</p>
      ) : (
        assets.map((entry) => <HoodAssetCard key={entry.asset.symbol} {...entry} />)
      )}

      <section className="mt-8">
        <h3 className="text-[17px] font-semibold">Why your balance is in shares</h3>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">
          The app never keeps your balance as a count of tokens. Every buy is
          converted, at the moment it lands, into equity units: the token
          amount times that token&rsquo;s own multiplier, adjusted for its
          decimals, at nine decimal places. One billion equity units is one
          share, whichever token carried it.
        </p>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">
          So a buy that arrives as one token and a buy that arrives as the
          other add up correctly, and a withdrawal can be paid in either,
          converted back at that token&rsquo;s multiplier. Counting tokens
          instead would put a small error into every balance, and a large one
          wherever two tokens use different decimals.
        </p>
      </section>

      <section className="mt-8 rounded-2xl border border-line bg-white/60 p-4 text-[14px]">
        <Row label="Program" value={short(PROGRAM_ID.toBase58())} />
        <a
          href={explorer(PROGRAM_ID.toBase58())}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-[14px] font-medium text-accent"
        >
          View the program on Solana Explorer
        </a>
        <p className="mt-2 text-[13px] text-muted">
          Network: {ADDRESS_BOOK.cluster}. The tokens here are test copies
          carrying the real tokens&rsquo; multipliers.
        </p>
      </section>
    </Shell>
  );
}

function short(address: string): string {
  return `${address.slice(0, 4)}\u2026${address.slice(-4)}`;
}

function HoodAssetCard({ asset, sources, equity }: HoodAsset) {
  const held = sources.reduce((sum, source) => sum + holdingInShares(source), 0n);
  // Ordered so "more" is always true: the token carrying less of a share
  // first, the one carrying more second.
  const [a, b] = [...sources].sort((x, y) => (x.multFixed < y.multFixed ? -1 : 1));

  return (
    <section className="mt-8">
      <h3 className="text-[17px] font-semibold">{asset.displayName}</h3>

      <div className="mt-3 space-y-3">
        {sources.map((source) => (
          <div key={source.wrapper.mint} className="rounded-2xl border border-line bg-white/60 p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-[16px] font-semibold">{source.wrapper.label}</span>
              <a
                href={explorer(source.wrapper.mint)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[12px] text-accent"
              >
                {short(source.wrapper.mint)}
              </a>
            </div>
            <div className="mt-2 font-mono text-[13px]">
              <Row label="Multiplier" value={String(source.multiplier)} />
              <Row label="Decimals" value={String(source.wrapper.decimals)} />
              <Row
                label="1 token is"
                value={`${exactAmount(sharesPerWholeToken(source), asset.receiptDecimals)} shares`}
              />
              <Row
                label="Vault holds"
                value={exactAmount(source.vaultBalance, source.wrapper.decimals)}
              />
            </div>
            {source.pending ? (
              <p className="mt-1 text-[12px] text-muted">
                Scheduled to change to {String(source.pending.multiplier)} on{" "}
                {new Date(source.pending.effectiveTs * 1000).toLocaleDateString()}.
              </p>
            ) : null}
          </div>
        ))}
      </div>

      {a && b ? (
        <div className="mt-3 rounded-2xl bg-accentSoft p-4 text-[14px] leading-relaxed text-ink">
          <p>
            <strong>Why they differ.</strong> {a.wrapper.label} uses{" "}
            {a.wrapper.decimals} decimals and {b.wrapper.label} uses{" "}
            {b.wrapper.decimals}, so one raw unit of{" "}
            {a.wrapper.decimals < b.wrapper.decimals ? a.wrapper.label : b.wrapper.label}{" "}
            is {10 ** Math.abs(a.wrapper.decimals - b.wrapper.decimals)} times larger
            to begin with. Then each carries its own multiplier, the adjustment
            its issuer applies for corporate actions such as dividends, and
            those have drifted apart.
          </p>
          <p className="mt-2">
            Once the decimals are lined up, one {b.wrapper.label} is worth{" "}
            {relativePercent(a.multFixed, b.multFixed)}{" "}
            of a share more than one {a.wrapper.label}. Small, but a swap that
            treated them one for one would be wrong by exactly that, on every
            trade.
          </p>
        </div>
      ) : (
        <p className="mt-3 text-[14px] text-muted">
          One token backs {asset.displayName} today. The vault is built to take
          more, and would hold them side by side in the same way.
        </p>
      )}

      <div className="mt-3 font-mono text-[13px]">
        <Row label="Receipts outstanding" value={`${exactAmount(equity, asset.receiptDecimals)} shares`} />
        <Row label="Tokens held, in shares" value={`${exactAmount(held, asset.receiptDecimals)} shares`} />
      </div>
      <p className="text-[12px] leading-relaxed text-muted">
        What the vault owes its savers, against what its tokens are worth at
        today&rsquo;s multipliers. Each conversion rounds down in the
        vault&rsquo;s favour, so the second is never meant to fall short of
        the first.
      </p>
    </section>
  );
}
