/**
 * Display helpers.
 *
 * The product rule these exist to enforce: a person using this app owns
 * NVIDIA, not NVDAx, and they own shares, not raw token units at nine
 * decimals scaled by a multiplier. Nothing in here can render a wrapper name,
 * a multiplier or a basis point, because nothing in here is ever given one.
 */

/** Turns a raw integer amount at `decimals` into a Number for display only. */
function toNumber(raw: bigint, decimals: number): number {
  const scale = 10 ** decimals;
  return Number(raw) / scale;
}

/**
 * Shares, to four decimal places. Four because a five dollar buy of a two
 * hundred dollar share is 0.025 of one, and a person saving weekly should see
 * their number move every single week or the whole point is lost.
 */
export function formatShares(rawEquityUnits: bigint, decimals: number): string {
  return toNumber(rawEquityUnits, decimals).toLocaleString(undefined, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
}

export function sharesToNumber(rawEquityUnits: bigint, decimals: number): number {
  return toNumber(rawEquityUnits, decimals);
}

export function formatMoney(raw: bigint, decimals: number): string {
  return toNumber(raw, decimals).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

/** Whole dollars where the cents are always zero, as in the preset amounts. */
export function formatMoneyShort(raw: bigint, decimals: number): string {
  const value = toNumber(raw, decimals);
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/**
 * "every Friday", "every day", "every 2 weeks". Derived from the schedule's
 * own cadence and next run, never assumed, so a plan set to something other
 * than weekly still reads as a sentence.
 */
export function cadencePhrase(cadenceSeconds: number, nextDueTs: number): string {
  const day = 24 * 60 * 60;
  if (cadenceSeconds === 7 * day) {
    const weekday = new Date(nextDueTs * 1000).toLocaleDateString(undefined, {
      weekday: "long",
    });
    return `every ${weekday}`;
  }
  if (cadenceSeconds === day) {
    return "every day";
  }
  if (cadenceSeconds % (7 * day) === 0) {
    return `every ${cadenceSeconds / (7 * day)} weeks`;
  }
  if (cadenceSeconds % day === 0) {
    return `every ${cadenceSeconds / day} days`;
  }
  return `every ${Math.round(cadenceSeconds / 3600)} hours`;
}

/** "Friday", or "today" when it is due now. Used for the next-run line. */
export function whenNext(nextDueTs: number): string {
  const now = Date.now() / 1000;
  if (nextDueTs <= now) {
    return "today";
  }
  const days = Math.ceil((nextDueTs - now) / (24 * 60 * 60));
  if (days <= 1) {
    return "tomorrow";
  }
  return new Date(nextDueTs * 1000).toLocaleDateString(undefined, {
    weekday: "long",
  });
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/**
 * A typed dollar amount to raw units, or null if it is not one. Parsed as a
 * string, never through a float, so "4.10" is exactly 4.10 and not
 * 4.0999999. Cents at most: a person saving does not mean a tenth of a cent.
 */
export function parseMoney(text: string, decimals: number): bigint | null {
  return parseDecimal(text.replace(/^\s*\$/, ""), decimals, 2);
}

/**
 * A typed share count to raw equity units, to four places, the same precision
 * shares are shown at. Anything finer is not something a person can see, so
 * it is not something they should be able to type.
 */
export function parseShares(text: string, decimals: number): bigint | null {
  return parseDecimal(text, decimals, 4);
}

function parseDecimal(
  text: string,
  decimals: number,
  maxFraction: number,
): bigint | null {
  const pattern = new RegExp(`^\\s*(\\d{0,9})(?:\\.(\\d{0,${maxFraction}}))?\\s*$`);
  const match = pattern.exec(text);
  if (!match || (match[1] === "" && !match[2])) {
    return null;
  }
  const whole = BigInt(match[1] || "0");
  const fraction = BigInt((match[2] ?? "").padEnd(maxFraction, "0"));
  return (
    whole * 10n ** BigInt(decimals) + fraction * 10n ** BigInt(decimals - maxFraction)
  );
}

/**
 * "14 weeks in a row", in the plan's own unit when every counted buy ran at
 * that pace, otherwise "14 buys in a row". Null under two, because a streak of
 * one is just a buy. See computeStreak for what "in a row" is checked against.
 */
export function streakPhrase(count: number, cadenceSeconds: number | null): string | null {
  if (count < 2) {
    return null;
  }
  const day = 24 * 60 * 60;
  const unit =
    cadenceSeconds === day
      ? "day"
      : cadenceSeconds === 7 * day
        ? "week"
        : cadenceSeconds === 30 * day
          ? "month"
          : "buy";
  return `${count} ${unit}s in a row`;
}

/**
 * A gain or loss as words, never as a colour: "Up $12.40 (4.1%)",
 * "Down $3.20 (1.1%)". The sign is carried by the word so the number can be
 * set in the same ink either way, and a red day reads as information rather
 * than as an error.
 */
export function changePhrase(
  gain: bigint,
  percent: number | null,
  decimals: number,
): string {
  const magnitude = gain < 0n ? -gain : gain;
  const money = formatMoney(magnitude, decimals);
  const pct =
    percent === null
      ? ""
      : ` (${Math.abs(percent).toLocaleString(undefined, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        })}%)`;
  if (gain === 0n) {
    return "Even with what you put in";
  }
  return `${gain > 0n ? "Up" : "Down"} ${money}${pct}`;
}

/**
 * How current a price is. "Live" within fifteen minutes; otherwise the time it
 * was set, which outside market hours is the last close: "as of Fri 4:00 PM".
 */
export function priceAge(publishTime: number, now = Date.now() / 1000): string {
  if (now - publishTime < 15 * 60) {
    return "Prices are live";
  }
  const when = new Date(publishTime * 1000);
  const sameDay = new Date(now * 1000).toDateString() === when.toDateString();
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day =
    now - publishTime < 6 * 24 * 60 * 60
      ? when.toLocaleDateString(undefined, { weekday: "short" })
      : when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return sameDay ? `Prices as of ${time}` : `Prices as of ${day} ${time}`;
}

/** Raw units back to the text a person would type, "5" or "4.10". */
export function moneyInput(raw: bigint, decimals: number): string {
  const value = toNumber(raw, decimals);
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * How many whole buys an allowance pays for, and the date of the last one.
 * The last date counts from the next buy, or from now if that is overdue, since
 * an overdue buy runs as soon as a keeper reaches it.
 */
export function allowanceReach(params: {
  allowance: bigint;
  amount: bigint;
  cadenceSeconds: number;
  nextDueTs: number;
}): { buys: number; lastTs: number | null } {
  const { allowance, amount, cadenceSeconds, nextDueTs } = params;
  if (amount <= 0n) {
    return { buys: 0, lastTs: null };
  }
  const buys = Number(allowance / amount);
  if (buys === 0) {
    return { buys, lastTs: null };
  }
  const first = Math.max(nextDueTs, Math.floor(Date.now() / 1000));
  return { buys, lastTs: first + (buys - 1) * cadenceSeconds };
}

/** "Dec 12", with the year only when it is not this one. */
export function shortDate(ts: number): string {
  const date = new Date(ts * 1000);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}
