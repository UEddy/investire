/**
 * Latest price of each asset's underlying, from Pyth.
 *
 * Server side for the same reason the RPC proxy is: since 2026-08-26 Hermes
 * needs an API key for price reads, and a key in client code is a key every
 * visitor has. See src/lib/pyth.ts, which this shares with the cash out route.
 *
 * Every price is returned with its publish time, and the client says how old
 * it is. The feeds are US equities, so from Friday's close to Monday's open the
 * latest price is Friday's, and showing it as "now" would be the kind of small
 * untruth a savings app does not get to tell.
 */
import { readPrices } from "@/lib/pyth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface PriceQuote {
  /** Integer mantissa as a decimal string; value = price * 10^expo. */
  price: string;
  expo: number;
  /** Unix seconds. */
  publishTime: number;
}

export async function GET(): Promise<Response> {
  const read = await readPrices();
  if (read.kind === "unavailable") {
    return Response.json(
      { error: "prices-unavailable", reason: read.reason },
      { status: read.status, headers: { "cache-control": "no-store" } },
    );
  }

  const prices: Record<string, PriceQuote> = {};
  for (const [symbol, quote] of Object.entries(read.quotes)) {
    prices[symbol] = {
      price: quote.price.toString(),
      expo: quote.expo,
      publishTime: quote.publishTime,
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
