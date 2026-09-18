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
