/**
 * US equity market hours, as far as this app needs them.
 *
 * Buys happen only on a live price, and the prices are US equities, so a buy
 * due on a Saturday happens at Monday's open. Two things on screen have to
 * know that to stay honest: when the next buy will actually happen, and
 * whether a gap between two buys was a missed buy or just a weekend.
 *
 * Regular hours only, 9:30 to 16:00 New York time, Monday to Friday. Exchange
 * holidays are not modelled: on one, a buy waits a day longer than this says,
 * and a daily plan's streak can break across it. Both are small, and both err
 * towards saying less than is true rather than more.
 */

const NEW_YORK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

function newYork(ts: number): { weekday: string; minutes: number } {
  const parts = NEW_YORK.formatToParts(new Date(ts * 1000));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: get("weekday"),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;

function isWeekend(ts: number): boolean {
  const { weekday } = newYork(ts);
  return weekday === "Sat" || weekday === "Sun";
}

export function isMarketOpen(ts: number): boolean {
  const { weekday, minutes } = newYork(ts);
  return weekday !== "Sat" && weekday !== "Sun" && minutes >= OPEN && minutes < CLOSE;
}

/**
 * The first moment at or after ts when the market is open. Walks in five
 * minute steps, at most a week, which is plenty for any weekend.
 */
export function nextMarketOpen(ts: number): number {
  const step = 5 * 60;
  let t = ts;
  for (let i = 0; i < (7 * 24 * 60) / 5 && !isMarketOpen(t); i++) {
    t = Math.ceil((t + 1) / step) * step;
  }
  return t;
}

/**
 * Seconds between a and b that fell on a weekday, New York time. Counted in
 * hour steps, which is fine for gaps of days to weeks. A gap measured this
 * way from Friday to Monday is one day, which is what it is to a daily plan
 * that cannot buy on a Saturday.
 */
export function weekdaySeconds(a: number, b: number): number {
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  const hour = 3600;
  let weekend = 0;
  for (let t = from; t < to; t += hour) {
    if (isWeekend(t)) {
      weekend += Math.min(hour, to - t);
    }
  }
  return to - from - weekend;
}
