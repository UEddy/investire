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
  PayoutSource,
  Plan,
  RUNS_FUNDED,
  loadPayoutSources,
  planPayout,
  planProblem,
} from "@/lib/paritas";
import { Prices, useSavings } from "@/lib/useSavings";
import { Portfolio, buildPortfolio, computeStreak } from "@/lib/portfolio";
import {
  allowanceReach,
  cadencePhrase,
  changePhrase,
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
        {overlay.kind === "withdraw" ? (
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

      <Footer cash={holdings?.cash ?? 0n} />
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
 * Taking shares out of savings and into the saver's own wallet.
 *
 * The amount is in shares, because that is what the saver has; there is no
 * price here to turn it into dollars honestly, and withdraw does not sell
 * anything. What the preview shows is the exact share count that lands, worked
 * out with the program's own integer math against the vault as it is now, so
 * the number on the button is the number in the wallet.
 */
function WithdrawForm({ savings, onClose }: { savings: Savings; onClose: () => void }) {
  const { connection } = useConnection();
  const shares = savings.holdings?.shares ?? {};
  const held = ASSETS.filter((asset) => (shares[asset.symbol] ?? 0n) > 0n);

  const [assetSymbol, setAssetSymbol] = useState(
    held[0]?.symbol ?? ASSETS[0].symbol,
  );
  const [text, setText] = useState("");
  const [all, setAll] = useState(false);
  const [sources, setSources] = useState<PayoutSource[] | null>(null);

  const asset = assetBySymbol(assetSymbol);
  const owned = shares[asset.symbol] ?? 0n;

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

  const amount = all ? owned : parseShares(text, asset.receiptDecimals);
  const tooMuch = amount !== null && amount > owned;
  const payout =
    amount !== null && amount > 0n && !tooMuch && sources
      ? planPayout(amount, sources)
      : null;
  const ready = payout?.kind === "ok";

  const submit = async () => {
    if (!ready || amount === null) {
      return;
    }
    if (await savings.withdraw(asset, amount)) {
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
          Take out shares
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
              caption={(each) =>
                `${formatShares(shares[each.symbol] ?? 0n, each.receiptDecimals)} shares`
              }
            />
          </div>
        ) : (
          <p className="mt-4 text-[15px] text-muted">
            You have {formatShares(owned, asset.receiptDecimals)} shares of{" "}
            {asset.displayName}.
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

        <div className="mt-6 min-h-[5rem] text-[15px] leading-relaxed">
          {tooMuch ? (
            <p className="text-ink">
              You have {formatShares(owned, asset.receiptDecimals)} shares of{" "}
              {asset.displayName}, so that is the most you can take out.
            </p>
          ) : amount !== null && amount > 0n && !sources ? (
            <p className="text-muted">Working it out</p>
          ) : payout?.kind === "short" ? (
            <p className="text-ink">
              {payout.available === 0n
                ? "That is too small to take out. Try a larger amount."
                : `Right now you can take out up to ${formatShares(
                    payout.available,
                    asset.receiptDecimals,
                  )} shares at once. Try that, or a smaller amount.`}
            </p>
          ) : payout?.kind === "ok" ? (
            <p className="rounded-2xl bg-accentSoft px-4 py-3 text-ink">
              You get{" "}
              <span className="tabular font-semibold">
                {formatShares(payout.received, asset.receiptDecimals)}
              </span>{" "}
              shares of {asset.displayName}, sent to your wallet to hold
              yourself. They leave your savings here, and any plan you have
              keeps buying as before.
            </p>
          ) : null}
        </div>
      </div>

      <motion.button
        whileTap={{ scale: 0.98 }}
        onClick={submit}
        disabled={savings.busy || !ready}
        className="mt-6 w-full rounded-2xl bg-ink py-4 text-[17px] font-semibold text-paper active:opacity-90 disabled:opacity-40"
      >
        {savings.busy
          ? "Taking out"
          : payout?.kind === "ok"
            ? `Take out ${formatShares(payout.received, asset.receiptDecimals)} shares`
            : "Take out"}
      </motion.button>

      {savings.error ? (
        <p className="mt-4 text-center text-[15px] text-ink">{savings.error}</p>
      ) : null}
    </Shell>
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
