/**
 * Shared pieces for the devnet demo scripts.
 *
 * The one rule this file exists to enforce: no address is written anywhere in
 * the scripts. Everything the mock environment creates goes into devnet.json,
 * and everything downstream, the lifecycle script, the keeper and the
 * frontend, reads it back from there. The only addresses that appear as
 * literals are in CONTEXT.md, and they arrive here through loadContext()
 * rather than being retyped.
 */
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

export const REPO_ROOT = path.resolve(__dirname, "..");
export const ADDRESS_BOOK_PATH = path.join(REPO_ROOT, "devnet.json");
export const CONTEXT_PATH = path.join(REPO_ROOT, "CONTEXT.md");

/** Fixed point scales, mirroring programs/paritas/src/multiplier.rs. */
export const MULTIPLIER_SCALE = 1_000_000_000_000_000_000n; // 1e18
export const RATE_SCALE = 1_000_000_000n; // 1e9
export const EQUITY_UNIT_DECIMALS = 9;

export interface WrapperEntry {
  label: string;
  mint: string;
  decimals: number;
  wrapper: string;
  vaultTokenAccount: string;
  ownerTokenAccount: string;
  /**
   * The multiplier the mock actually carries, which is the only number the
   * program ever reads off a wrapper mint. Equal, to the bit, to the live
   * multiplier of the mainnet mint this stands in for.
   */
  liveMultiplier: number;
  /** What CONTEXT.md records for the real mint this mocks. */
  mainnet: {
    mint: string;
    multiplier: number;
    newMultiplier: number;
    newMultiplierEffectiveTimestamp: number;
    liveMultiplier: number;
  };
}

/**
 * One vault: one underlying, its receipt mint, and the wrappers it accepts.
 */
export interface VaultEntry {
  symbol: string;
  /** Human name for the underlying, e.g. "NVIDIA". Display only. */
  displayName: string;
  /**
   * One plain line saying what owning this is. Display only, and written to
   * describe the underlying, never a wrapper.
   */
  description: string;
  address: string;
  receiptMint: string;
  receiptDecimals: number;
  tokenProgram: string;
  authority: string;
  keeperFeeBps: number;
  keeperFeeMin: string;
  wrappers: WrapperEntry[];
  /**
   * The Pyth feed pricing the underlying, not any wrapper. Optional because an
   * address book written before prices existed has none.
   */
  priceFeed?: { symbol: string; id: string };
  /** The setup wallet's receipt account for this vault. */
  ownerReceiptAccount: string;
}

export interface AddressBook {
  cluster: string;
  generatedAt: string;
  rpcUrl: string;
  programId: string;
  tokenProgram2022: string;
  tokenProgramClassic: string;
  payment: {
    label: string;
    mint: string;
    decimals: number;
    tokenProgram: string;
  };
  vault: {
    symbol: string;
    /** Human name for the underlying, e.g. "NVIDIA". Display only. */
    displayName: string;
    address: string;
    receiptMint: string;
    receiptDecimals: number;
    tokenProgram: string;
    authority: string;
    keeperFeeBps: number;
    keeperFeeMin: string;
  };
  wrappers: WrapperEntry[];
  /**
   * Every vault, the first being the one `vault` and `wrappers` above mirror.
   * Those two fields predate a second vault and are kept, identical to
   * vaults[0], so a keeper or script built against the single vault layout
   * keeps working against a rebuilt address book until it is updated.
   */
  vaults: VaultEntry[];
  /**
   * The devnet counterparty for cash outs: it buys the wrapper a user sells,
   * paying USDC into the escrow, in place of a Jupiter route. Public key only;
   * the secret lives in .devnet-keys and, for the app, in CASH_OUT_LIQUIDITY_KEY.
   */
  cashOutLiquidity?: string;
  owner: {
    address: string;
    paymentAccount: string;
    receiptAccount: string;
  };
  seeds: Record<string, string>;
}

export function loadAddressBook(): AddressBook {
  if (!fs.existsSync(ADDRESS_BOOK_PATH)) {
    throw new Error(
      `${ADDRESS_BOOK_PATH} not found. Run scripts/setup-devnet.ts first.`
    );
  }
  return JSON.parse(fs.readFileSync(ADDRESS_BOOK_PATH, "utf8")) as AddressBook;
}

/**
 * Every vault in an address book, including one written before `vaults`
 * existed, which is read as the single vault it describes.
 */
export function vaultsOf(book: AddressBook): VaultEntry[] {
  if (book.vaults?.length) {
    return book.vaults;
  }
  return [
    {
      description: "",
      ownerReceiptAccount: book.owner.receiptAccount,
      ...book.vault,
      wrappers: book.wrappers,
    },
  ];
}

export function loadAddressBookIfPresent(): AddressBook | null {
  try {
    return loadAddressBook();
  } catch {
    return null;
  }
}

export function saveAddressBook(book: AddressBook): void {
  fs.writeFileSync(ADDRESS_BOOK_PATH, `${JSON.stringify(book, null, 2)}\n`);
}

/**
 * The verified values this demo is built on, parsed out of CONTEXT.md rather
 * than copied into this file.
 *
 * CONTEXT.md is the ground truth and its hard rule is that nothing on chain
 * gets invented. Reading it at runtime keeps that literal: if a value there
 * changes, or the devnet USDC line is still an unfilled placeholder, these
 * scripts pick that up instead of running against a stale copy someone pasted
 * into the code months ago.
 */
export interface ContextFacts {
  devnetUsdcMint: PublicKey;
  nvdax: MintFacts;
  nvdaon: MintFacts;
  spyx: MintFacts;
  /** Pyth feed symbol to feed id, from the price feeds section. */
  priceFeeds: Record<string, string>;
}

export interface MintFacts {
  label: string;
  mainnetMint: string;
  decimals: number;
  multiplier: number;
  newMultiplier: number;
  newMultiplierEffectiveTimestamp: number;
}

/**
 * Returns the body of every section whose "## " heading starts with the given
 * text. Prefix rather than exact match, because CONTEXT.md's mint headings
 * carry a trailing provenance note ("read at mainnet slot ...") that is part
 * of the record and should not have to be reproduced here to find the block.
 */
function section(markdown: string, heading: string): string[] {
  const blocks: string[] = [];
  const lines = markdown.split("\n");
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current) {
        blocks.push(current.join("\n"));
      }
      current = line.slice(3).trim().startsWith(heading) ? [] : null;
      continue;
    }
    if (current) {
      current.push(line);
    }
  }
  if (current) {
    blocks.push(current.join("\n"));
  }
  return blocks;
}

function requireMatch(block: string, pattern: RegExp, what: string): string {
  const found = block.match(pattern);
  if (!found) {
    throw new Error(`CONTEXT.md: could not read ${what}`);
  }
  return found[1].trim();
}

function readMintFacts(
  markdown: string,
  heading: string,
  label: string
): MintFacts {
  const blocks = section(markdown, heading);
  if (blocks.length !== 1) {
    throw new Error(
      `CONTEXT.md has ${blocks.length} sections headed "${heading}", expected exactly 1`
    );
  }
  const block = blocks[0];
  return {
    label,
    mainnetMint: requireMatch(block, /^mint:\s*(\S+)/m, `${heading} mint`),
    decimals: Number(
      requireMatch(block, /^decimals:\s*(\d+)/m, `${heading} decimals`)
    ),
    multiplier: Number(
      requireMatch(
        block,
        /scaledUiAmountConfig\.multiplier:\s*([\d.]+)/,
        `${heading} multiplier`
      )
    ),
    newMultiplier: Number(
      requireMatch(
        block,
        /scaledUiAmountConfig\.newMultiplier:\s*([\d.]+)/,
        `${heading} newMultiplier`
      )
    ),
    newMultiplierEffectiveTimestamp: Number(
      requireMatch(
        block,
        /newMultiplierEffectiveTimestamp:\s*(\d+)/,
        `${heading} newMultiplierEffectiveTimestamp`
      )
    ),
  };
}

/**
 * "Equity.US.NVDA/USD: <64 hex>" lines from the Pyth section. Only lines of
 * exactly that shape count, so the section's prose naming feeds to avoid can
 * never be read as one to use.
 */
function readPriceFeeds(markdown: string): Record<string, string> {
  const blocks = section(markdown, "Pyth price feeds");
  if (blocks.length !== 1) {
    throw new Error(
      `CONTEXT.md has ${blocks.length} Pyth price feed sections, expected exactly 1`
    );
  }
  const feeds: Record<string, string> = {};
  for (const match of blocks[0].matchAll(/^(Equity\.[\w.]+\/USD):\s*([0-9a-f]{64})\s*$/gm)) {
    feeds[match[1]] = match[2];
  }
  return feeds;
}

export function loadContext(): ContextFacts {
  const markdown = fs.readFileSync(CONTEXT_PATH, "utf8");

  // CONTEXT.md currently carries two "## USDC" sections. They agree on
  // mainnet; one has the devnet line filled in and the other still says
  // PASTE_DEVNET_USDC_MINT_HERE. Rather than guess which block wins, take
  // every devnet line, discard unfilled placeholders, and insist that what is
  // left agrees with itself. A genuine disagreement stops the script.
  const usdcBlocks = section(markdown, "USDC");
  if (usdcBlocks.length === 0) {
    throw new Error('CONTEXT.md: no "## USDC" section');
  }
  const candidates = usdcBlocks
    .map((block) => block.match(/^devnet:\s*(\S+)/m)?.[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value) => !/^PASTE_/.test(value));

  const unique = Array.from(new Set(candidates));
  if (unique.length === 0) {
    throw new Error(
      "CONTEXT.md: the devnet USDC mint is still an unfilled placeholder. " +
        "Fill it in from faucet.circle.com before running this."
    );
  }
  if (unique.length > 1) {
    throw new Error(
      `CONTEXT.md: the USDC sections disagree on the devnet mint (${unique.join(
        ", "
      )}). ` + "Resolve CONTEXT.md before running this."
    );
  }

  return {
    devnetUsdcMint: new PublicKey(unique[0]),
    nvdax: readMintFacts(markdown, "NVDAx (Backed / xStocks)", "NVDAx"),
    nvdaon: readMintFacts(markdown, "NVDAon (Ondo Global Markets)", "NVDAon"),
    spyx: readMintFacts(markdown, "SPYx (Backed / xStocks)", "SPYx"),
    priceFeeds: readPriceFeeds(markdown),
  };
}

/**
 * Integer mirror of multiplier::current_multiplier_fixed. The single f64 step
 * is the multiply and round, exactly as in the program; everything after is
 * BigInt.
 */
export function currentMultiplierFixed(
  multiplier: number,
  newMultiplier: number,
  effectiveTimestamp: number,
  now: number
): bigint {
  const chosen = now >= effectiveTimestamp ? newMultiplier : multiplier;
  if (!Number.isFinite(chosen) || chosen <= 0) {
    throw new Error("invalid multiplier");
  }
  return BigInt(Math.round(chosen * Number(MULTIPLIER_SCALE)));
}

function pow10(exponent: number): bigint {
  let result = 1n;
  for (let i = 0; i < exponent; i++) {
    result *= 10n;
  }
  return result;
}

/** Integer mirror of multiplier::compute_rate. */
export function computeRate(
  multAFixed: bigint,
  decimalsA: number,
  multBFixed: bigint,
  decimalsB: number
): bigint {
  let numerator = multAFixed * RATE_SCALE;
  let denominator = multBFixed;
  if (decimalsB >= decimalsA) {
    numerator *= pow10(decimalsB - decimalsA);
  } else {
    denominator *= pow10(decimalsA - decimalsB);
  }
  const rate = numerator / denominator;
  if (rate === 0n) {
    throw new Error("rate truncated to zero");
  }
  return rate;
}

/**
 * Integer mirror of multiplier::to_equity_units. Used to work out what a
 * delivery is worth before submitting, so the lifecycle script can set a
 * meaningful floor instead of passing zero and trusting the caller.
 */
export function toEquityUnits(
  rawAmount: bigint,
  decimals: number,
  multFixed: bigint
): bigint {
  const rate = computeRate(
    multFixed,
    decimals,
    MULTIPLIER_SCALE,
    EQUITY_UNIT_DECIMALS
  );
  return (rawAmount * rate) / RATE_SCALE;
}

/**
 * Hard ceiling on one execution's keeper fee, in basis points of the buy.
 * Mirrors state::MAX_KEEPER_FEE_BPS.
 */
export const MAX_KEEPER_FEE_BPS = 200n;

/**
 * Integer mirror of schedule_math::keeper_fee. The larger of the vault's basis
 * points and its absolute minimum, then clamped to MAX_KEEPER_FEE_BPS of the
 * buy so a vault authority cannot set a fee that drains the schedules trusting
 * it.
 */
export function keeperFee(
  amountUsdc: bigint,
  feeBps: bigint,
  feeMin: bigint
): bigint {
  const fromBps = (amountUsdc * feeBps) / 10_000n;
  const ceiling = (amountUsdc * MAX_KEEPER_FEE_BPS) / 10_000n;
  const larger = fromBps > feeMin ? fromBps : feeMin;
  return larger < ceiling ? larger : ceiling;
}

/** Formats a raw token amount for human output. Display only. */
export function formatAmount(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const scale = pow10(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Retries a flaky RPC call with linear backoff.
 *
 * The public devnet endpoint drops requests often enough that a multi step
 * setup script will hit one most runs. Without this, a dropped read halfway
 * through leaves a half-built environment for the next run to reconcile.
 *
 * Failures come in two kinds and they are not interchangeable. Transport
 * failures and "Blockhash not found" mean the transaction provably never
 * executed, so resending is free. "Block height exceeded" means the opposite:
 * it is genuinely unknown whether the transaction landed, and resending on
 * that basis is how you mint twice. That one is only retried when the caller
 * passes idempotent, meaning it has looked at the operation and knows a second
 * execution is a no-op. Creating an associated token account idempotently
 * qualifies; minting a balance does not.
 */
export interface RetryOptions {
  attempts?: number;
  /** True only if running this operation twice is indistinguishable from once. */
  idempotent?: boolean;
  /**
   * Where the retry notice goes. Defaults to console.log, which suits a
   * script. A long running service passes its own logger so retries carry the
   * same timestamp and level as every other line in the journal.
   */
  onRetry?: (message: string) => void;
}

export async function withRetry<T>(
  what: string,
  action: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await action();
    } catch (err) {
      lastError = err;
      const message = String(err);

      const provablyDidNotExecute =
        /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|502|503|504|Too many requests|429|Blockhash not found|Node is behind/i.test(
          message
        );
      const outcomeUnknown =
        /block height exceeded|was not confirmed|Transaction was not confirmed/i.test(
          message
        );

      const retryable =
        provablyDidNotExecute ||
        (outcomeUnknown && options.idempotent === true);

      if (!retryable || attempt === attempts) {
        throw err;
      }

      const notify = options.onRetry ?? ((m: string) => console.log(m));
      notify(`retrying ${what}, attempt ${attempt + 1}/${attempts}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}
