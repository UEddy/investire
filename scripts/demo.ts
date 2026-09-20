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
 * none it says so rather than pretending. It is bounded: the keeper has
 * KEEPER_DECISION_SECONDS to answer, the wait shows its progress, and if it
 * does not answer the step says why and stops it. Nothing here may sit silent
 * or outlive the step, because the whole point is that it is filmed in one take.
 */
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { ChildProcess, spawn } from "child_process";
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
/**
 * How long step 6 waits for the keeper to reach a decision before it gives up
 * and says why. A recording must not sit on a silent screen: half a minute is
 * enough for ts-node to start and one devnet poll to run, and a slow network
 * can be given more with DEMO_KEEPER_TIMEOUT_SECONDS.
 */
const KEEPER_DECISION_SECONDS = (() => {
  const raw = Number(process.env.DEMO_KEEPER_TIMEOUT_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
})();

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One status line that rewrites itself in place, so a step waiting on a slow
 * child still looks alive on camera without filling the screen with ticks.
 * Anything printed while it is showing must go through its own printer, which
 * wipes the line first; where stdout is not a terminal there is nothing to
 * rewrite, so each update is simply a dim line of its own.
 */
function statusLine() {
  const tty = Boolean(process.stdout.isTTY);
  let width = 0;
  return {
    set(text: string): void {
      const line = `  ${text}`;
      if (!tty) {
        console.log(`${DIM}${line}${OFF}`);
        return;
      }
      const pad = " ".repeat(Math.max(0, width - line.length));
      process.stdout.write(`\r${DIM}${line}${OFF}${pad}`);
      width = line.length;
    },
    clear(): void {
      if (tty && width > 0) {
        process.stdout.write(`\r${" ".repeat(width)}\r`);
      }
      width = 0;
    },
    /** Prints a line without leaving the status text behind it. */
    print(text: string): void {
      this.clear();
      console.log(text);
    },
  };
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

/**
 * fetch with a deadline, for the devnet reads this script makes. The default
 * has none: an endpoint that accepts the connection and then never answers
 * leaves the request outstanding forever, and the step with it. The abort is
 * not one of the errors withRetry treats as transient, so it ends the read
 * rather than starting another wait of the same length, and the caller says
 * devnet is not answering. Retries still happen for the failures it does know.
 */
function boundedFetch(seconds: number) {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(seconds * 1_000) })) as any;
}

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

/** How step 6's wait on the keeper ended. */
type Outcome = "decided" | "timeout" | "gone";

/**
 * Serves one deliberately stale Pyth price to the real keeper, on localhost,
 * and shows it refusing to buy at it. Nothing is mocked inside the keeper: it
 * is the shipped binary, reading a price over HTTP as it always does, and the
 * only thing arranged is that the price is three days old.
 *
 * Bounded, because this is filmed. The keeper gets KEEPER_DECISION_SECONDS to
 * reach a decision, the wait shows its progress the whole time, and every way
 * out of here, including the ones nobody wants, ends in one line saying what
 * happened and a stopped keeper.
 */
async function staleKeeperDemo(): Promise<void> {
  const book = loadAddressBook();
  const feeds = vaultsOf(book)
    .map((v) => v.priceFeed?.id.replace(/^0x/, "").toLowerCase())
    .filter((id): id is string => Boolean(id));

  let due: number;
  note("Looking for a due schedule on devnet.");
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
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (err) {
    note(
      `Could not open the stale price feed on 127.0.0.1:${port}: ` +
        `${err instanceof Error ? err.message : String(err)}.`,
    );
    return;
  }

  const keeper = spawn(
    "npx",
    // --transpile-only because the type check is a good half of the keeper's
    // startup and is not what this step is showing. Same code, sooner.
    ["ts-node", "--transpile-only", "--project", "tsconfig.scripts.json", "keeper/index.ts"],
    {
      cwd: REPO_ROOT,
      // Its own process group. npx does not pass signals on to ts-node, so
      // signalling npx alone left the keeper running and this script alive
      // with it, long after the step was over.
      detached: true,
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

  // A keeper in its own process group no longer dies with the terminal's
  // Ctrl-C, so the demo passes one on itself rather than orphaning it.
  const relay = () => {
    stopKeeper(keeper).finally(() => process.exit(130));
  };
  process.once("SIGINT", relay);

  // Only the lines worth filming: what it is pricing from, what is due, and
  // the decision. No startup noise.
  const interesting = /pricing deliveries|schedule\(s\) due|skip |executed /;
  // Any of the three is the keeper answering, which is what we came to film:
  // it bought, it refused, or it tried and the chain said no.
  const decisive = /skip |executed |failed /;
  const status = statusLine();
  const startedAt = Date.now();
  const elapsed = () => Math.round((Date.now() - startedAt) / 1000);

  let sawSkip = false;
  let lastLine = "";
  let lastError = "";
  // What it had last said when the budget ran out, held apart from lastLine
  // so the explanation quotes the line it stalled on and not its goodbye.
  let stalledOn = "";

  const outcome = await new Promise<Outcome>((resolve) => {
    let settled = false;
    const finish = (how: Outcome, after = 0) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(ticker);
      clearTimeout(deadline);
      setTimeout(() => resolve(how), after);
    };

    const stage = () => {
      if (!lastLine) {
        return "starting the keeper";
      }
      return /schedule\(s\) due/.test(lastLine)
        ? "the keeper is checking the price"
        : "the keeper is starting up on devnet";
    };
    const ticker = setInterval(
      () => status.set(`${stage()}, ${elapsed()}s of ${KEEPER_DECISION_SECONDS}s`),
      5_000,
    );
    const deadline = setTimeout(() => {
      stalledOn = lastLine;
      finish("timeout");
    }, KEEPER_DECISION_SECONDS * 1_000);

    keeper.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) {
          continue;
        }
        lastLine = line;
        if (!interesting.test(line)) {
          continue;
        }
        const trimmed = line.replace(/^\S+\s+/, "");
        const isSkip = /skip /.test(trimmed);
        status.print(`  ${isSkip ? BOLD + trimmed + OFF : trimmed}`);
        if (decisive.test(trimmed)) {
          sawSkip = isSkip;
          // A breath for the next line of the same decision, then stop.
          finish("decided", 500);
        }
      }
    });
    // Read, both so a failure to start has something to report and so a full
    // pipe can never be what stalls the keeper. An execution the chain
    // rejected is logged here rather than on stdout, and it is as much of an
    // answer as a skip is, so it ends the wait too.
    keeper.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) {
          continue;
        }
        lastError = line.trim();
        const trimmed = lastError.replace(/^\S+\s+/, "");
        if (decisive.test(trimmed)) {
          status.print(`  ${trimmed}`);
          finish("decided", 500);
        }
      }
    });
    keeper.on("error", (err) => {
      lastError = err.message;
      finish("gone");
    });
    keeper.on("exit", () => finish("gone"));
  });

  status.clear();
  process.off("SIGINT", relay);
  await stopKeeper(keeper);
  await new Promise<void>((resolve) => server.close(() => resolve()));

  blank();
  if (sawSkip) {
    note("The buy is not made and the schedule stays due. It will be retried every");
    note("poll until the price is live, which outside US market hours means Monday.");
    note("A scheduled buy at a stale price is the failure this project is about.");
  } else if (outcome === "decided") {
    note("The keeper decided, but not by skipping: its line is above.");
  } else if (outcome === "gone") {
    const why = (lastError || lastLine).replace(/^\S+\s+/, "");
    note(`The keeper stopped before deciding: ${why || "it printed nothing"}.`);
  } else {
    note(
      `No decision in ${KEEPER_DECISION_SECONDS}s (${
        stalledOn
          ? `stalled after: ${stalledOn.replace(/^\S+\s+/, "")}`
          : "the keeper printed nothing"
      }); rerun with DEMO_KEEPER_TIMEOUT_SECONDS set higher.`,
    );
  }
}

/**
 * Stops the keeper and everything npx started for it, and waits until it is
 * actually gone. The signal goes to the process group, by negative pid,
 * because npx keeps ts-node to itself: signalling the child alone leaves the
 * keeper polling and its pipes open, and an open pipe keeps this script alive
 * forever after the step has finished. SIGINT first, since the keeper exits
 * cleanly on it, then SIGKILL for the case where it does not.
 */
async function stopKeeper(keeper: ChildProcess): Promise<void> {
  const pid = keeper.pid;
  if (!pid || keeper.exitCode !== null || keeper.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => keeper.once("exit", () => resolve()));
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone, which is the outcome we wanted.
    }
  };

  signalGroup("SIGINT");
  const stopped = await Promise.race([exited.then(() => true), delay(3_000).then(() => false)]);
  if (!stopped) {
    signalGroup("SIGKILL");
    await Promise.race([exited, delay(1_000)]);
  }
  // Nothing here may hold the event loop open once the step is over.
  keeper.stdout?.destroy();
  keeper.stderr?.destroy();
  keeper.stdin?.destroy();
  keeper.unref();
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
  const connection = new Connection(process.env.KEEPER_RPC_URL ?? DEVNET, {
    commitment: "confirmed",
    fetch: boundedFetch(12),
  });
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
  // Three attempts, not the default five, on a request that cannot outlast
  // boundedFetch: past that the honest thing on camera is to say devnet is
  // not answering, rather than to keep the screen still.
  const all = (await withRetry(
    "read schedules",
    () => (program.account as any).schedule.all(),
    { idempotent: true, attempts: 3, onRetry: (m) => note(`  ${m}`) },
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
