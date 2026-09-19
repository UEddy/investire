/**
 * Server side reads of Pyth prices for this app's assets. Server only: the
 * Hermes key is PYTH_API_KEY, which has no NEXT_PUBLIC_ prefix, and must
 * never be imported into client code.
 *
 * The feed ids come from the address book, never from a caller, so nothing
 * built on this can be used as an open, keyed proxy to a paid API.
 */
import { ASSETS } from "./config";

const DEFAULT_HERMES = "https://pyth.dourolabs.app/hermes";

/**
 * How old a price may be and still be traded on. Pyth publishes equities many
 * times a second while the market is open, so a minute old means it is not.
 * The keeper uses the same figure, so a devnet cash out and a devnet buy
 * agree on when a price is live.
 */
export const MAX_TRADE_PRICE_AGE_SECONDS = 60;

export interface ServerQuote {
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: number;
}

export type PriceRead =
  | { kind: "ok"; quotes: Record<string, ServerQuote> }
  | { kind: "unavailable"; reason: string; status: number };

interface HermesParsed {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
}

/** Latest price per asset symbol, or why there are none. */
export async function readPrices(): Promise<PriceRead> {
  const key = process.env.PYTH_API_KEY?.trim();
  if (!key) {
    return { kind: "unavailable", reason: "PYTH_API_KEY is not configured", status: 503 };
  }
  const feeds = ASSETS.filter((asset) => asset.priceFeed).map((asset) => ({
    symbol: asset.symbol,
    id: asset.priceFeed!.id.replace(/^0x/, "").toLowerCase(),
  }));
  if (feeds.length === 0) {
    return { kind: "unavailable", reason: "no price feeds in the address book", status: 503 };
  }

  const base = (process.env.PYTH_HERMES_URL ?? DEFAULT_HERMES).replace(/\/$/, "");
  const query = feeds.map((feed) => `ids[]=${feed.id}`).join("&");

  let parsed: HermesParsed[];
  try {
    const response = await fetch(`${base}/v2/updates/price/latest?${query}&parsed=true`, {
      headers: { authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      // Status only. An auth failure's body is not worth the risk of echoing
      // anything about the key back to a public caller.
      return {
        kind: "unavailable",
        reason: `price service returned ${response.status}`,
        status: 502,
      };
    }
    parsed = ((await response.json()) as { parsed?: HermesParsed[] }).parsed ?? [];
  } catch (err) {
    return {
      kind: "unavailable",
      reason: err instanceof Error ? err.name : "fetch failed",
      status: 502,
    };
  }

  // Matched by id, and each value checked for shape, before anything is
  // handed to code that multiplies money by it.
  const quotes: Record<string, ServerQuote> = {};
  for (const feed of feeds) {
    const quote = parsed.find(
      (item) => item.id.replace(/^0x/, "").toLowerCase() === feed.id,
    )?.price;
    if (
      !quote ||
      !/^\d+$/.test(quote.price) ||
      quote.price === "0" ||
      !/^\d+$/.test(quote.conf) ||
      !Number.isInteger(quote.expo) ||
      !Number.isInteger(quote.publish_time)
    ) {
      continue;
    }
    quotes[feed.symbol] = {
      price: BigInt(quote.price),
      conf: BigInt(quote.conf),
      expo: quote.expo,
      publishTime: quote.publish_time,
    };
  }
  return { kind: "ok", quotes };
}

/** A quote as raw payment units per whole share. Rounds down. */
export function paymentPerShare(quote: ServerQuote, paymentDecimals: number): bigint {
  const shift = paymentDecimals + quote.expo;
  return shift >= 0
    ? quote.price * 10n ** BigInt(shift)
    : quote.price / 10n ** BigInt(-shift);
}

/**
 * Whether a quote is fit to trade on: live, and with a confidence interval
 * inside one percent of the price. Showing a stale price with its age is
 * honest; selling at one is not.
 */
export function tradeable(quote: ServerQuote, now = Date.now() / 1000): boolean {
  return (
    now - quote.publishTime <= MAX_TRADE_PRICE_AGE_SECONDS &&
    quote.conf * 100n <= quote.price
  );
}
