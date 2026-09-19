/**
 * Latest price of each asset's underlying, from Pyth.
 *
 * Server side for the same reason the RPC proxy is: since 2026-08-26 Hermes
 * needs an API key for price reads, and a key in client code is a key every
 * visitor has. PYTH_API_KEY has no NEXT_PUBLIC_ prefix and never leaves here.
 *
 * The feed ids come from the address book, not from the request. A route that
 * fetched whatever ids a caller asked for would be an open, keyed proxy to a
 * paid API. This one answers exactly one question: what are this app's assets
 * worth.
 *
 * Every price is returned with its publish time, and the client says how old
 * it is. The feeds are US equities, so from Friday's close to Monday's open the
 * latest price is Friday's, and showing it as "now" would be the kind of small
 * untruth a savings app does not get to tell.
 */
import { ASSETS } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_HERMES = "https://pyth.dourolabs.app/hermes";

export interface PriceQuote {
  /** Integer mantissa as a decimal string; value = price * 10^expo. */
  price: string;
  expo: number;
  /** Unix seconds. */
  publishTime: number;
}

interface HermesParsed {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
}

export async function GET(): Promise<Response> {
  const key = process.env.PYTH_API_KEY?.trim();
  if (!key) {
    return Response.json(
      { error: "prices-unavailable", reason: "PYTH_API_KEY is not configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const feeds = ASSETS.filter((asset) => asset.priceFeed).map((asset) => ({
    symbol: asset.symbol,
    id: asset.priceFeed!.id.replace(/^0x/, "").toLowerCase(),
  }));
  if (feeds.length === 0) {
    return Response.json(
      { error: "prices-unavailable", reason: "no price feeds in the address book" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const base = (process.env.PYTH_HERMES_URL ?? DEFAULT_HERMES).replace(/\/$/, "");
  const query = feeds.map((feed) => `ids[]=${feed.id}`).join("&");

  let parsed: HermesParsed[];
  try {
    const response = await fetch(
      `${base}/v2/updates/price/latest?${query}&parsed=true`,
      {
        headers: { authorization: `Bearer ${key}` },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) {
      // Status only. The body of an auth failure is not worth the risk of
      // echoing anything about the key back to a public caller.
      return Response.json(
        { error: "prices-unavailable", reason: `price service returned ${response.status}` },
        { status: 502, headers: { "cache-control": "no-store" } },
      );
    }
    parsed = ((await response.json()) as { parsed?: HermesParsed[] }).parsed ?? [];
  } catch (err) {
    return Response.json(
      {
        error: "prices-unavailable",
        reason: err instanceof Error ? err.name : "fetch failed",
      },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }

  // Matched by id, and each value checked for shape, before anything is
  // handed to code that multiplies money by it.
  const prices: Record<string, PriceQuote> = {};
  for (const feed of feeds) {
    const entry = parsed.find(
      (item) => item.id.replace(/^0x/, "").toLowerCase() === feed.id,
    );
    const quote = entry?.price;
    if (
      !quote ||
      !/^\d+$/.test(quote.price) ||
      quote.price === "0" ||
      !Number.isInteger(quote.expo) ||
      !Number.isInteger(quote.publish_time)
    ) {
      continue;
    }
    prices[feed.symbol] = {
      price: quote.price,
      expo: quote.expo,
      publishTime: quote.publish_time,
    };
  }

  return Response.json(
    { prices },
    {
      // Shared briefly at the edge, so a busy page costs one Hermes read per
      // quarter minute rather than one per visitor.
      headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=45" },
    },
  );
}
