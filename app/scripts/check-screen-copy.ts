/**
 * Keeps raw failures off the screen, the way the glossary in verify-devnet.ts
 * keeps retired words off it. Two halves:
 *
 * The source. The error line on screen has one setter, and it runs every
 * string through onScreen(). This fails if anything writes the state directly,
 * or hands the setter an error's message, status or body instead of a
 * sentence.
 *
 * The behaviour. friendly() is fed failures in the shapes they actually arrive
 * in, the RPC client's `500 : {"error":"..."}` first among them, and every
 * sentence it returns has to pass looksTechnical(). A new branch that echoes
 * a status or a body fails here before it ships.
 *
 * Runs before every build, so a deploy cannot carry a regression.
 */
import fs from "node:fs";
import {
  NETWORK_DOWN,
  UNEXPLAINED,
  friendly,
  looksTechnical,
  onScreen,
} from "../src/lib/useSavings";

let failures = 0;
const report = console.error.bind(console);

function fail(message: string): void {
  report(`FAIL  ${message}`);
  failures++;
}

function ok(message: string): void {
  console.log(`ok    ${message}`);
}

/** As in verify-devnet.ts: blanked, not removed, so line numbers hold. */
function stripComments(source: string): string {
  const blank = (comment: string) => comment.replace(/[^\n]/g, " ");
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^\s*\/\/.*$/gm, blank);
}

const HOOK = "src/lib/useSavings.ts";

/** What may not be handed to setError, and why. */
const RAW_ARGUMENTS: { pattern: RegExp; what: string }[] = [
  { pattern: /\.message\b/, what: "an error's message" },
  { pattern: /\.status\b|\bstatus\b/, what: "a status" },
  { pattern: /JSON\.stringify|\bbody\b|\.json\(/, what: "a response body" },
  { pattern: /^\s*(?:String\()?\s*(?:err|error|e)\s*\)?\s*$/, what: "the error itself" },
];

function checkSource(): void {
  const before = failures;
  const source = stripComments(fs.readFileSync(new URL(`../${HOOK}`, import.meta.url), "utf8"));
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;

  // One direct write: the setter that wraps it.
  const direct = [...source.matchAll(/\bsetShownError\(/g)];
  if (direct.length !== 1) {
    fail(
      `${HOOK} writes the error line directly ${direct.length} times. ` +
        "Use setError, which runs the text through onScreen.",
    );
  }

  for (const call of source.matchAll(/\bsetError\(([^;]*?)\);/g)) {
    const argument = call[1];
    for (const { pattern, what } of RAW_ARGUMENTS) {
      if (pattern.test(argument)) {
        fail(
          `${HOOK}:${lineOf(call.index!)} puts ${what} on screen: setError(${argument}). ` +
            "Log it with console.error and show a sentence.",
        );
      }
    }
  }

  // A sentence that interpolates a status or a body is the same leak with
  // extra steps: `the service answered ${body.status}`.
  for (const hit of source.matchAll(/`[^`]*\$\{[^}]*(?:\.status|\bbody\b|\.message)[^}]*\}[^`]*`/g)) {
    fail(`${HOOK}:${lineOf(hit.index!)} builds copy from a status, body or message: ${hit[0]}`);
  }
  if (failures === before) {
    ok("the error line has one setter, and nothing raw is handed to it");
  }
}

/**
 * Failures in the shapes they arrive in. Most are what the RPC client and
 * fetch produce when /api/rpc or a server route fails.
 */
const RAW: { name: string; err: unknown; expect?: string }[] = [
  {
    name: "RPC proxy 500",
    err: new Error('500 : {"error":"RPC_URL is not configured on the server"}'),
    expect: NETWORK_DOWN,
  },
  {
    name: "RPC proxy 502 with host",
    err: new Error(
      '502 Bad Gateway: {"error":"the RPC endpoint could not be reached","host":"x.example","reason":"fetch failed"}',
    ),
    expect: NETWORK_DOWN,
  },
  {
    name: "web3.js wrapping a failed read",
    err: new Error(
      'failed to get recent blockhash: Error: 503 : {"error":"the RPC endpoint rejected the request","status":429}',
    ),
    expect: NETWORK_DOWN,
  },
  { name: "browser offline", err: new TypeError("Failed to fetch"), expect: NETWORK_DOWN },
  { name: "Safari offline", err: new TypeError("Load failed"), expect: NETWORK_DOWN },
  {
    name: "JSON-RPC error body",
    err: new Error('{"jsonrpc":"2.0","error":{"code":-32603,"message":"Internal error"},"id":1}'),
  },
  {
    name: "SolanaJSONRPCError",
    err: new Error("failed to send transaction: SolanaJSONRPCError: -32002 Transaction simulation failed"),
  },
  { name: "stack only", err: new Error("\n    at fetch (webpack://app/src/lib/x.ts:12:3)") },
  { name: "a thrown string", err: 'HTTP 500 {"error":"boom"}' },
  { name: "a thrown object", err: { status: 500, error: "boom" } },
  { name: "html error page", err: new Error("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON") },
];

function checkBehaviour(): void {
  const before = failures;
  for (const { name, err, expect } of RAW) {
    const shown = onScreen(friendly(err));
    if (looksTechnical(shown)) {
      fail(`${name}: the screen would say ${JSON.stringify(shown)}`);
    } else if (expect && shown !== expect) {
      fail(`${name}: expected ${JSON.stringify(expect)}, got ${JSON.stringify(shown)}`);
    }
  }
  // The guard's own replacements have to pass the guard.
  for (const line of [NETWORK_DOWN, UNEXPLAINED]) {
    if (looksTechnical(line)) {
      fail(`looksTechnical flags its own fallback, ${JSON.stringify(line)}`);
    }
  }
  if (failures === before) {
    ok(`${RAW.length} raw failures come out as plain sentences`);
  }
}

// onScreen logs what it holds back. That is the point in the browser; here it
// is noise around the verdict.
console.error = () => {};
checkSource();
checkBehaviour();
if (failures > 0) {
  report(`\n${failures} leak${failures === 1 ? "" : "s"} of raw failures onto the screen.`);
  process.exit(1);
}
