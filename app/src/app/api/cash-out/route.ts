/**
 * Quotes and co-signs devnet cash outs.
 *
 * DEVNET ONLY. A cash out is one transaction: begin_cash_out, the sale,
 * settle_cash_out. On mainnet the sale is a Jupiter route the user signs
 * alone, and this route does not need to exist. On devnet the sale is a
 * transfer from a liquidity key's USDC (see the DEVNET SUBSTITUTE banner in
 * src/lib/paritas.ts), and that key has to sign its own transfer. So this
 * route builds the transaction, signs the liquidity key's part, and hands it
 * back for the user to sign and send. One transaction, one wallet prompt.
 *
 * What the liquidity key's signature can be used for is exactly this
 * transaction and nothing else. A signature covers the whole message, so a
 * client that altered any instruction, account or amount would invalidate
 * it; the blockhash expires it within about a minute; and the user pays every
 * fee and rent, so an unsubmitted co-signature costs the key nothing.
 *
 * The price is configured, not quoted from a market, to match the keeper's
 * devnet buy substitute: KEEPER_QUOTE_USDC_PER_SHARE and this route's
 * CASH_OUT_QUOTE_USDC_PER_SHARE default to the same 5.00, so on devnet a
 * share is bought and sold at one price and the liquidity key's USDC is not
 * drained by the gap between a mock buy price and a real sell price.
 */
import { AnchorProvider, Idl, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ADDRESS_BOOK, ASSETS, PARITAS_IDL } from "@/lib/config";
import { parseMoney } from "@/lib/format";
import {
  PAYMENT_MINT,
  buildCashOutTransaction,
  loadPayoutSources,
  ownerReceiptAccount,
  planCashOut,
} from "@/lib/paritas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(status: number, error: string, extra: Record<string, string> = {}) {
  return Response.json(
    { error, ...extra },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** Same tolerance for pasted quotes as the RPC proxy. */
function rpcUrl(): string | null {
  const raw = process.env.RPC_URL?.trim().replace(/^["']|["']$/g, "");
  return raw && /^https?:\/\//.test(raw) ? raw : null;
}

function liquidityKey(): Keypair | null {
  const raw = process.env.CASH_OUT_LIQUIDITY_KEY?.trim();
  if (!raw) {
    return null;
  }
  try {
    const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    // Refuse a key that is not the one the address book names, rather than
    // co-signing with whatever happens to be configured.
    return keypair.publicKey.toBase58() === ADDRESS_BOOK.cashOutLiquidity ? keypair : null;
  } catch {
    return null;
  }
}

function pricePerShare(symbol: string): bigint | null {
  const text =
    process.env[`CASH_OUT_QUOTE_${symbol}`] ??
    process.env.CASH_OUT_QUOTE_USDC_PER_SHARE ??
    "5";
  const raw = parseMoney(text, ADDRESS_BOOK.payment.decimals);
  return raw && raw > 0n ? raw : null;
}

export async function POST(request: Request): Promise<Response> {
  let body: { owner?: string; asset?: string; shares?: string; mode?: string };
  try {
    body = await request.json();
  } catch {
    return fail(400, "bad-request");
  }

  let owner: PublicKey;
  try {
    owner = new PublicKey(body.owner ?? "");
  } catch {
    return fail(400, "bad-request");
  }
  const asset = ASSETS.find((entry) => entry.symbol === body.asset);
  const shares = /^\d{1,20}$/.test(body.shares ?? "") ? BigInt(body.shares!) : 0n;
  if (!asset || shares === 0n || (body.mode !== "quote" && body.mode !== "build")) {
    return fail(400, "bad-request");
  }

  const url = rpcUrl();
  const liquidity = liquidityKey();
  const price = pricePerShare(asset.symbol);
  if (!url || !liquidity || !price) {
    return fail(503, "cash-out-unavailable");
  }

  const connection = new Connection(url, "confirmed");
  // Anchor only needs a wallet here to build instructions, never to sign:
  // the one signature this route makes is the explicit partialSign below.
  // Anchor's Wallet class is also absent from the browser build Next
  // resolves, so a signer that refuses is both simpler and safer.
  const readOnly = {
    publicKey: liquidity.publicKey,
    signTransaction: () => Promise.reject(new Error("not used")),
    signAllTransactions: () => Promise.reject(new Error("not used")),
  } as unknown as AnchorProvider["wallet"];
  const program = new Program(
    PARITAS_IDL as Idl,
    new AnchorProvider(connection, readOnly, { commitment: "confirmed" }),
  ) as Program<Idl>;

  try {
    const held = await getAccount(
      connection,
      ownerReceiptAccount(owner, asset),
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    )
      .then((account) => account.amount)
      .catch(() => 0n);
    if (shares > held) {
      return fail(400, "more-than-held", { held: held.toString() });
    }

    const plan = planCashOut(shares, await loadPayoutSources(connection, asset), price);
    if ("short" in plan) {
      return fail(409, "vault-short", { available: plan.short.toString() });
    }

    const liquidityUsdc = await getAccount(
      connection,
      getAssociatedTokenAddressSync(PAYMENT_MINT, liquidity.publicKey, false, TOKEN_PROGRAM_ID),
      "confirmed",
      TOKEN_PROGRAM_ID,
    )
      .then((account) => account.amount)
      .catch(() => 0n);
    if (liquidityUsdc < plan.paymentOut) {
      return fail(409, "liquidity-short", {
        // The most it could pay, as shares, so the screen can offer it.
        available: ((liquidityUsdc * 10n ** BigInt(asset.receiptDecimals)) / price).toString(),
      });
    }

    const quote = {
      sharesSold: plan.sharesSold.toString(),
      paymentOut: plan.paymentOut.toString(),
    };
    if (body.mode === "quote") {
      return Response.json(quote, { headers: { "cache-control": "no-store" } });
    }

    const transaction = await buildCashOutTransaction({
      program,
      owner,
      asset,
      shares,
      plan,
      liquidity: liquidity.publicKey,
    });
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash;
    transaction.partialSign(liquidity);

    return Response.json(
      {
        ...quote,
        transaction: transaction
          .serialize({ requireAllSignatures: false, verifySignatures: true })
          .toString("base64"),
        lastValidBlockHeight,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    // Name, never message: messages from RPC errors can carry the endpoint.
    return fail(502, "cash-out-failed", {
      reason: err instanceof Error ? err.name : "unknown",
    });
  }
}
