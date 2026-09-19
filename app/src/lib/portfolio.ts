/**
 * The numbers behind the dashboard, kept free of React and of the chain so
 * they can be checked in isolation. Everything is integer math on raw units:
 * shares at the receipt's nine decimals, dollars at the payment mint's six,
 * prices as Pyth's mantissa and exponent. Floats appear only at the very end,
 * for a percentage that is displayed and never added to anything.
 */
import type { Execution, Plan } from "./paritas";

export interface Quote {
  price: bigint;
  expo: number;
  publishTime: number;
}

export interface AssetPosition {
  symbol: string;
  /** Shares held now, raw. */
  shares: bigint;
  /**
   * Dollars put in for the shares still held, raw. Equal to what the plans
   * spent unless shares have been taken out since, in which case it is scaled
   * down by the fraction taken, at average cost. Without that, taking half
   * the shares out would read as losing half the money.
   */
  invested: bigint;
  /** Worth at the quoted price, raw dollars; null with no price. */
  value: bigint | null;
  /** value minus invested, over the shares whose cost is known. */
  gain: bigint | null;
  /** gain as a percentage of invested; null with no price or no cost. */
  gainPercent: number | null;
  /**
   * Shares held beyond what the plans bought, from a direct deposit say. Their
   * cost is not on chain, so they count toward value but not toward gain,
   * rather than being treated as free and inflating it.
   */
  sharesWithoutCost: bigint;
}

export interface Portfolio {
  assets: AssetPosition[];
  invested: bigint;
  /** Null unless every held asset has a price: a partial total is not a total. */
  value: bigint | null;
  gain: bigint | null;
  gainPercent: number | null;
  /** The oldest price used, so the screen can say how current the value is. */
  pricedAt: number | null;
}

/** shares (raw, shareDecimals) times a Pyth price, in raw dollars. Rounds down. */
export function valueOf(
  shares: bigint,
  shareDecimals: number,
  quote: Quote,
  moneyDecimals: number,
): bigint {
  // value = shares / 10^sd * price * 10^expo, expressed in units of 10^-md.
  const shift = moneyDecimals + quote.expo - shareDecimals;
  const product = shares * quote.price;
  return shift >= 0 ? product * 10n ** BigInt(shift) : product / 10n ** BigInt(-shift);
}

function percent(gain: bigint, base: bigint): number | null {
  if (base === 0n) {
    return null;
  }
  // Basis points of precision in integer math, then one float divide.
  return Number((gain * 10_000n) / base) / 100;
}

export function buildPortfolio(params: {
  assets: { symbol: string; receiptDecimals: number }[];
  shares: Record<string, bigint>;
  plans: Plan[];
  quotes: Record<string, Quote> | null;
  moneyDecimals: number;
}): Portfolio {
  const { assets, shares, plans, quotes, moneyDecimals } = params;

  const positions: AssetPosition[] = assets.map((asset) => {
    const held = shares[asset.symbol] ?? 0n;
    const mine = plans.filter((plan) => plan.asset === asset.symbol);
    const bought = mine.reduce((sum, plan) => sum + plan.sharesTotal, 0n);
    const spent = mine.reduce((sum, plan) => sum + plan.investedTotal, 0n);

    const withCost = held < bought ? held : bought;
    const invested = bought === 0n ? 0n : (spent * withCost) / bought;
    const quote = quotes?.[asset.symbol];

    if (!quote) {
      return {
        symbol: asset.symbol,
        shares: held,
        invested,
        value: null,
        gain: null,
        gainPercent: null,
        sharesWithoutCost: held - withCost,
      };
    }

    const value = valueOf(held, asset.receiptDecimals, quote, moneyDecimals);
    const gain =
      valueOf(withCost, asset.receiptDecimals, quote, moneyDecimals) - invested;
    return {
      symbol: asset.symbol,
      shares: held,
      invested,
      value,
      gain,
      gainPercent: percent(gain, invested),
      sharesWithoutCost: held - withCost,
    };
  });

  const relevant = positions.filter((position) => position.shares > 0n);
  const invested = relevant.reduce((sum, position) => sum + position.invested, 0n);
  const priced = relevant.every((position) => position.value !== null);
  const value = priced
    ? relevant.reduce((sum, position) => sum + (position.value ?? 0n), 0n)
    : null;
  const gain = priced
    ? relevant.reduce((sum, position) => sum + (position.gain ?? 0n), 0n)
    : null;

  const times = relevant
    .map((position) => quotes?.[position.symbol]?.publishTime)
    .filter((ts): ts is number => ts !== undefined);

  return {
    assets: positions,
    invested,
    value,
    gain,
    gainPercent: gain === null ? null : percent(gain, invested),
    pricedAt: times.length ? Math.min(...times) : null,
  };
}

export interface Streak {
  /** Consecutive buys, ending with the most recent. */
  count: number;
  /** The unit to count them in, when every one of them ran at the same pace. */
  cadenceSeconds: number | null;
}

/**
 * Consecutive buys, counted back from the latest, provable from chain history.
 *
 * Two buys are consecutive when the second came before a whole period of the
 * later plan's pace was missed: under twice its cadence after the first. A buy
 * that ran a day late still counts; a week skipped on a weekly plan does not.
 * Changing a plan does not break it, because the replacement keeps the old
 * plan's next date, so its first buy lands a period after the last one.
 *
 * The streak is live only while a plan is: with nothing active, or the active
 * plan already a whole period overdue, it has ended, and saying otherwise
 * would be flattery.
 */
export function computeStreak(
  executions: Execution[],
  active: Plan | null,
  now: number,
): Streak {
  const none = { count: 0, cadenceSeconds: null };
  if (!active || executions.length === 0) {
    return none;
  }
  const sorted = [...executions].sort((a, b) => b.ts - a.ts);
  if (now - sorted[0].ts >= 2 * active.cadenceSeconds) {
    return none;
  }

  let count = 1;
  for (let i = 1; i < sorted.length; i++) {
    const later = sorted[i - 1];
    if (later.ts - sorted[i].ts >= 2 * later.cadenceSeconds) {
      break;
    }
    count++;
  }

  const counted = sorted.slice(0, count);
  const pace = counted.every((each) => each.cadenceSeconds === counted[0].cadenceSeconds)
    ? counted[0].cadenceSeconds
    : null;
  return { count, cadenceSeconds: pace };
}
