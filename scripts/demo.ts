/**
 * The demo, for recording in one take.
 *
 * Six steps, each with a number and a title so the recording cuts into
 * sections cleanly, and a keypress between them so the pace is the narrator's.
 * Every mainnet value is read live when the step runs, never cached and never
 * hardcoded, so what a viewer sees is what the chain says at that moment.
 *
 *   npm run demo              pause between steps, for recording
 *   npm run demo -- --no-pause  straight through, for checking it still works
 *
 * Step 6 runs the real keeper against devnet with a deliberately stale price
 * and shows it refusing the buy. It needs a schedule that is due; if there is
 * none it says so rather than pretending.
 */
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { spawn } from "child_process";
import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  EQUITY_UNIT_DECIMALS,
  MULTIPLIER_SCALE,
  REPO_ROOT,
  fromEquityUnits,
  loadAddressBook,
  vaultsOf,
  withRetry,
} from "./devnet-lib";

const MAINNET = process.env.DEMO_MAINNET_RPC ?? "https://api.mainnet-beta.solana.com";
const DEVNET = process.env.DEMO_DEVNET_RPC ?? "https://api.devnet.solana.com";
const PAUSE = !process.argv.includes("--no-pause");

// --- presentation ----------------------------------------------------------

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";
const RULE = "=".repeat(64);

function step(number: number, title: string): void {
  console.log(`\n${BOLD}${RULE}${OFF}`);
  console.log(`${BOLD} STEP ${number}   ${title}${OFF}`);
  console.log(`${BOLD}${RULE}${OFF}\n`);
}

function label(text: string): void {
  console.log(`${BOLD}${text}${OFF}`);
}

function field(name: string, value: string): void {
  // Two spaces of gap even when a label runs to the full width, so a value
  // can never end up touching its own label on screen.
  console.log(`  ${name.padEnd(36)}  ${value}`);
}

function note(text: string): void {
  console.log(`${DIM}${text}${OFF}`);
}

function blank(): void {
  console.log("");
}

/** Waits for one keypress, so the narrator sets the pace. */
async function pause(): Promise<void> {
  if (!PAUSE) {
    return;
  }
  process.stdout.write(`\n${DIM}   press any key${OFF}`);
  await new Promise<void>((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.once("data", () => {
      if (stdin.setRawMode) {
        stdin.setRawMode(wasRaw ?? false);
      }
      stdin.pause();
      resolve();
    });
  });
  process.stdout.write("\r" + " ".repeat(20) + "\r");
}

// --- chain reads -----------------------------------------------------------

interface ScaledConfig {
  authority: string;
  multiplier: string;
  newMultiplier: string;
  newMultiplierEffectiveTimestamp: number;
}

interface MintRead {
  slot: number;
  decimals: number;
  config: ScaledConfig;
  /** The multiplier in force right now, by the program's own rule. */
  live: number;
}

/**
 * Reads one mint and returns its scaled UI amount configuration and nothing
 * else. The live multiplier is chosen the way multiplier.rs chooses it:
 * newMultiplier once its effective timestamp has passed.
 */
async function readMint(connection: Connection, mint: string): Promise<MintRead> {
  const response = await connection.getParsedAccountInfo(new PublicKey(mint), "finalized");
  const value = response.value;
  if (!value || !("parsed" in value.data)) {
    throw new Error(`could not read ${mint}`);
  }
  const info = value.data.parsed.info as {
    decimals: number;
    extensions: { extension: string; state: ScaledConfig }[];
  };
  const config = info.extensions.find((e) => e.extension === "scaledUiAmountConfig")?.state;
  if (!config) {
    throw new Error(`${mint} has no scaledUiAmountConfig`);
  }
  const now = Math.floor(Date.now() / 1000);
  return {
    slot: response.context.slot,
    decimals: info.decimals,
    config,
    live:
      now >= Number(config.newMultiplierEffectiveTimestamp)
        ? Number(config.newMultiplier)
        : Number(config.multiplier),
  };
}

function showConfig(name: string, mint: string, read: MintRead): void {
  label(`${name}   ${mint}`);
  field("read at slot", String(read.slot));
  field("decimals", String(read.decimals));
  blank();
  label("  scaledUiAmountConfig");
  field("  multiplier", read.config.multiplier);
  field("  newMultiplier", read.config.newMultiplier);
  field(
    "  newMultiplierEffectiveTimestamp",
    `${read.config.newMultiplierEffectiveTimestamp}   ${DIM}${new Date(
      Number(read.config.newMultiplierEffectiveTimestamp) * 1000,
    ).toISOString()}${OFF}`,
  );
}

function ageOf(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  if (days >= 1) {
    const months = Math.floor(days / 30);
    return months >= 1 ? `${days} days, about ${months} months` : `${days} days`;
  }
  return `${Math.round(seconds / 3600)} hours`;
}

// --- steps -----------------------------------------------------------------

async function main(): Promise<void> {
  const book = loadAddressBook();
  const vaults = vaultsOf(book);
  const wrappers = vaults.flatMap((v) => v.wrappers);
  const real = (label: string) => {
    const found = wrappers.find((w) => w.label === label);
    if (!found) {
      throw new Error(`${label} is not in the address book`);
    }
    return found.mainnet.mint;
  };
  const NVDAX = real("NVDAx");
  const NVDAON = real("NVDAon");
  const SPYX = real("SPYx");

  const mainnet = new Connection(MAINNET, "confirmed");

  console.log(`\n${BOLD}Investire: what the chain actually says${OFF}`);
  note(`mainnet rpc ${MAINNET}`);
  note("every value below is read live when its step runs");
  await pause();

  // --- 1 -------------------------------------------------------------------
  step(1, "NVDAx, read live from mainnet");
  const nvdax = await readMint(mainnet, NVDAX);
  showConfig("NVDAx, Backed xStocks", NVDAX, nvdax);
  blank();
  note("One company, one share. This is the field that carries its dividends.");
  await pause();

  // --- 2 -------------------------------------------------------------------
  step(2, "NVDAon, and the drift between the two");
  const nvdaon = await readMint(mainnet, NVDAON);
  showConfig("NVDAon, Ondo Global Markets", NVDAON, nvdaon);
  blank();

  label("The same share, two issuers, side by side");
  field("NVDAx live multiplier", nvdax.live.toString());
  field("NVDAon live multiplier", nvdaon.live.toString());
  field("decimals", `${nvdax.decimals} against ${nvdaon.decimals}`);
  blank();

  const drift = (nvdaon.live - nvdax.live) / nvdax.live;
  label("The drift, with the arithmetic");
  console.log(`  (${nvdaon.live} - ${nvdax.live}) / ${nvdax.live}`);
  console.log(`    = ${drift.toExponential(4)}`);
  console.log(`    = ${BOLD}${(drift * 1e6).toFixed(2)} parts per million${OFF}`);
  console.log(`    = ${BOLD}${(drift * 10000).toFixed(4)} basis points${OFF}`);
  blank();
  note("One raw unit of one is not one raw unit of the other. No app reads this.");
  await pause();

  // --- 3 -------------------------------------------------------------------
  step(3, "SPYx, and the field that lies");
  const spyx = await readMint(mainnet, SPYX);
  showConfig("SPYx, Backed xStocks", SPYX, spyx);
  blank();

  const effectiveTs = Number(spyx.config.newMultiplierEffectiveTimestamp);
  const stale = Math.floor(Date.now() / 1000) - effectiveTs;
  const gap =
    (Number(spyx.config.newMultiplier) - Number(spyx.config.multiplier)) /
    Number(spyx.config.multiplier);

  label("What is actually in force");
  field("effective, from newMultiplier", spyx.config.newMultiplier);
  field("the field named multiplier", spyx.config.multiplier);
  field(
    "its timestamp passed",
    `${new Date(effectiveTs * 1000).toISOString()}   ${BOLD}${ageOf(stale)} ago${OFF}`,
  );
  blank();

  label("The gap, with the arithmetic");
  console.log(
    `  (${spyx.config.newMultiplier} - ${spyx.config.multiplier}) / ${spyx.config.multiplier}`,
  );
  console.log(`    = ${gap.toExponential(4)}`);
  console.log(`    = ${BOLD}${(gap * 10000).toFixed(2)} basis points${OFF}`);
  blank();
  note("Read the field named multiplier and you are that far out, indefinitely,");
  note("and nothing on the mint flags it.");
  await pause();

  // --- 4 -------------------------------------------------------------------
  step(4, "Equity units: 0.1 shares, paid in either wrapper");
  const shares = 10n ** BigInt(EQUITY_UNIT_DECIMALS) / 10n; // 0.1 shares
  const fixed = (value: number) => BigInt(Math.round(value * Number(MULTIPLIER_SCALE)));
  const xRaw = fromEquityUnits(shares, nvdax.decimals, fixed(nvdax.live));
  const onRaw = fromEquityUnits(shares, nvdaon.decimals, fixed(nvdaon.live));

  label("0.1 shares of NVIDIA, as each wrapper pays it");
  field("NVDAx", `${xRaw.toString().padStart(12)} raw   ${tokens(xRaw, nvdax.decimals)}`);
  field("NVDAon", `${onRaw.toString().padStart(12)} raw   ${tokens(onRaw, nvdaon.decimals)}`);
  blank();

  const ratio = Number(onRaw) / Number(xRaw);
  label("Why the two raw amounts differ");
  console.log(`  ${onRaw} / ${xRaw} = ${ratio.toFixed(5)}`);
  console.log(
    `  ten of that is the decimals: 10^${nvdaon.decimals} against 10^${nvdax.decimals}`,
  );
  console.log(
    `  the rest is the drift: 10 x (${nvdax.live} / ${nvdaon.live}) = ${(
      10 *
      (nvdax.live / nvdaon.live)
    ).toFixed(5)}`,
  );
  blank();
  note("Both are 0.1 shares. Neither is 0.1 tokens. The program stores the shares,");
  note(`at ${EQUITY_UNIT_DECIMALS} decimals, and converts at each wrapper's own multiplier.`);
  await pause();

  // --- 5 -------------------------------------------------------------------
  step(5, "One buy is three instructions");
  label("The transaction a keeper submits");
  console.log("  [0]  ComputeBudget");
  console.log(`  [1]  ${BOLD}begin_execution${OFF}   debit the saver's delegated allowance,`);
  console.log("                          open an escrow derived from this schedule");
  console.log(`  [2]  ${BOLD}swap${OFF}              Jupiter on mainnet, inventory on devnet.`);
  console.log("                          The program never inspects it");
  console.log(`  [3]  ${BOLD}settle_execution${OFF}  measure, value, credit, pay, close`);
  blank();

  label("What settle_execution refuses to skip");
  for (const check of [
    "exactly one begin_execution and one settle_execution in the transaction",
    "no other instruction of this program anywhere in it",
    "begin came before settle",
    "this settle is the top level instruction the scan found, not a CPI",
    "that begin was this schedule's, by its receipt address",
    "the schedule is active, belongs to this vault, and is due",
    "the receipt's due date is the one still standing on the schedule",
    "the debited amount and the fee match what the program recomputes",
    "the escrow holds the wrapper the receipt named",
    "the escrow is not empty",
    "what arrived, valued at the live multiplier, clears the owner's floor",
  ]) {
    console.log(`  - ${check}`);
  }
  blank();
  note("The escrow is created in this transaction and closed in it, so its balance");
  note("is what this swap delivered. No shared account, nothing to subtract.");
  note("Then: sweep to the vault, mint receipts to the owner, pay the caller's fee,");
  note("advance the due date, ratchet the floor onto what was actually bought.");
  await pause();

  // --- 6 -------------------------------------------------------------------
  step(6, "A stale price stops the buy");
  await staleKeeperDemo();

  console.log(`\n${BOLD}${RULE}${OFF}`);
  console.log(`${BOLD} End. Numbers and how to check them: SOURCES.md${OFF}`);
  console.log(`${BOLD}${RULE}${OFF}\n`);
}

function tokens(raw: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  return `${raw / scale}.${(raw % scale).toString().padStart(decimals, "0")}`;
}

/**
 * Serves one deliberately stale Pyth price to the real keeper, on localhost,
 * and shows it refusing to buy at it. Nothing is mocked inside the keeper: it
 * is the shipped binary, reading a price over HTTP as it always does, and the
 * only thing arranged is that the price is three days old.
 */
async function staleKeeperDemo(): Promise<void> {
  const book = loadAddressBook();
  const feeds = vaultsOf(book)
    .map((v) => v.priceFeed?.id.replace(/^0x/, "").toLowerCase())
    .filter((id): id is string => Boolean(id));

  let due: number;
  try {
    due = await countDueSchedules();
  } catch (err) {
    // A recording must not end in a stack trace. Devnet being slow is not a
    // failure of anything this step is demonstrating.
    label("Could not reach devnet to look for a due schedule.");
    note(`  ${err instanceof Error ? err.message : String(err)}`);
    note("Steps 1 to 5 above are mainnet reads and are unaffected.");
    return;
  }
  if (due === 0) {
    label("No schedule is due on devnet right now, so there is nothing to skip.");
    note("Create one in the app, or with scripts/run-lifecycle.ts, then rerun this step.");
    return;
  }
  label(`${due} schedule(s) due on devnet. Serving the keeper a price three days old.`);
  blank();

  const port = 4899;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer demo-key") {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const ids = url.searchParams.getAll("ids[]");
    const publish = Math.floor(Date.now() / 1000) - 3 * 86400;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        parsed: ids
          .filter((id) => feeds.includes(id))
          .map((id) => ({
            id,
            price: { price: "21101503", conf: "11050", expo: -5, publish_time: publish },
          })),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  const keeper = spawn(
    "npx",
    ["ts-node", "--project", "tsconfig.scripts.json", "keeper/index.ts"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        KEEPER_PRICE_SOURCE: "pyth",
        PYTH_API_KEY: "demo-key",
        PYTH_HERMES_URL: `http://127.0.0.1:${port}`,
        KEEPER_RPC_URL: process.env.KEEPER_RPC_URL ?? DEVNET,
        KEEPER_KEYPAIR:
          process.env.KEEPER_KEYPAIR ?? path.join(REPO_ROOT, ".devnet-keys", "keeper.json"),
        KEEPER_POLL_SECONDS: "15",
      },
    },
  );

  // Only the lines worth filming: what it is pricing from, what is due, and
  // the refusal. No startup noise.
  const interesting = /pricing deliveries|schedule\(s\) due|skip |executed /;
  let sawSkip = false;
  await new Promise<void>((resolve) => {
    const done = () => {
      keeper.kill("SIGINT");
      resolve();
    };
    const timer = setTimeout(done, 90_000);
    keeper.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (!interesting.test(line)) {
          continue;
        }
        const trimmed = line.replace(/^\S+\s+/, "");
        console.log(`  ${trimmed.includes("skip") ? BOLD + trimmed + OFF : trimmed}`);
        if (trimmed.includes("skip")) {
          sawSkip = true;
          clearTimeout(timer);
          setTimeout(done, 500);
        }
      }
    });
    keeper.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  server.close();

  blank();
  if (sawSkip) {
    note("The buy is not made and the schedule stays due. It will be retried every");
    note("poll until the price is live, which outside US market hours means Monday.");
    note("A scheduled buy at a stale price is the failure this project is about.");
  } else {
    note("The keeper did not reach a skip line in time. Its log is above.");
  }
}

main().catch((err) => {
  console.error(`\n${BOLD}The demo stopped: ${err instanceof Error ? err.message : String(err)}${OFF}`);
  process.exit(1);
});

/**
 * How many schedules the keeper would consider due right now, on devnet.
 * Decoded by Anchor from the IDL rather than by counting bytes, so a change
 * to the Schedule layout cannot quietly make this miscount.
 */
async function countDueSchedules(): Promise<number> {
  const book = loadAddressBook();
  const connection = new Connection(process.env.KEEPER_RPC_URL ?? DEVNET, "confirmed");
  const idlPath =
    process.env.PARITAS_IDL ?? path.join(REPO_ROOT, "target/idl/paritas.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8")) as anchor.Idl;
  const readOnly = {
    publicKey: PublicKey.default,
    signTransaction: () => Promise.reject(new Error("read only")),
    signAllTransactions: () => Promise.reject(new Error("read only")),
  } as unknown as anchor.Wallet;
  const program = new Program(
    idl,
    new anchor.AnchorProvider(connection, readOnly, { commitment: "confirmed" }),
  ) as Program<anchor.Idl>;

  const vaultKeys = new Set(vaultsOf(book).map((v) => v.address));
  const now = Math.floor(Date.now() / 1000);
  // Retried, because one dropped request from a public endpoint should not
  // end a recording.
  const all = (await withRetry(
    "read schedules",
    () => (program.account as any).schedule.all(),
    { idempotent: true, onRetry: (m) => note(`  ${m}`) },
  )) as {
    account: { vault: PublicKey; nextDueTs: BN; active: boolean };
  }[];
  return all.filter(
    (entry) =>
      entry.account.active &&
      vaultKeys.has(entry.account.vault.toBase58()) &&
      entry.account.nextDueTs.toNumber() <= now,
  ).length;
}
