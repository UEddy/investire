# Investire

A savings app. You put in a few dollars a day, a week or a month and you own
shares of the companies you believe in. Two assets are live, NVIDIA and the
S&P 500, one vault each; the list on screen comes from the address book, so
a third is a new vault and a `setup-devnet.ts` entry, not a frontend change.

Next.js App Router, Tailwind, Motion, deployable to Vercel.

## What it deliberately does not show

The program underneath swaps between two tokenised wrappers of the same
equity, reads a Token-2022 ScaledUiAmount multiplier off each mint, and keeps
balances in equity units so the two are comparable. None of that appears in
the UI. A person using this owns NVIDIA, not NVDAx, and they own shares, not
raw token amounts at nine decimals. There are no multipliers, no basis points,
no wrapper names and no token amounts anywhere on screen.

Shares are the hero number because shares only go up when you buy weekly. The
dollar figure is secondary, smaller, and is what you have put in rather than
what it is worth today, so the app does not feel awful on a red day.

## Addresses

Every address comes from `devnet.json` at the repo root, written by
`scripts/setup-devnet.ts`. `scripts/sync-config.mjs` copies it and the Anchor
IDL into `src/config/` before `dev` and `build`, so the Next module graph stays
inside this directory. Both copies are gitignored; the originals are the source
of truth. Nothing on chain is named anywhere else in this codebase.

To point the app at a different deployment, ship a different `devnet.json`.

## One plan at a time

An SPL token account holds exactly one delegate. Funding a plan approves that
plan's PDA as the delegate on your dollar account, so approving a second plan
against the same account silently overwrites the first, and the first then
fails on its next run with no warning to anyone.

The two ways out are a separate dollar account per plan, or one plan per
account. A separate account means asking someone saving five dollars a week to
move money into a second pocket before they can start, and leaves funds
stranded there when they stop. For a savings app that is worse than the limit
it removes, and v1 carries no multi asset allocation anyway.

So the UI blocks it, names the plan holding the delegation, and offers to stop
that one first. A delegate that is not one of your plans blocks too: it belongs
to something set up elsewhere, and quietly revoking it would be the same
failure with a different victim. `checkFundingBlock` in `src/lib/paritas.ts` is
the whole of it.

## Three taps

1. Start saving
2. Pick what to own, an amount, and how often: daily, weekly, or every 30 days
3. Confirm

Any amount can be typed; the chips are shortcuts. The screen checks the
program's own floors before the wallet is asked (the smallest plan is the
larger of one dollar and the amount whose capped keeper fee covers the vault's
minimum), so a plan that is too small is a sentence on screen and not a failed
transaction. A monthly plan is 30 days, because the program stores cadence in
seconds and has no calendar.

One wallet approval, because creating the plan and funding it are instructions
in a single transaction. Stopping is a tap, a soft confirm and one approval,
and revokes the delegation in the same transaction so nothing can move your money afterwards
even if the program were wrong about that.

## What the app can take

A plan is funded for 12 buys at its amount, whatever the cadence, and not a
cent more. The plan card shows the live allowance read off your dollar
account, how many buys it covers and the date of the last one. When it runs
out the plan pauses and says so, with one tap to allow 12 more.

## Stopping

Stop is on the plan card itself, never behind the detail view. It asks once,
softly, so a stray thumb does not end a habit, and then cancels the plan and
revokes the permission in the same transaction. Nothing is locked.

## Taking money out

"Take out", next to the shares figure, offers two ways side by side, each
showing what it pays for the amount of shares entered:

- **Take the shares.** `withdraw` burns receipt tokens and pays out the same
  number of shares as wrapper tokens in the saver's own wallet.
- **Cash out.** One transaction the saver signs: `begin_cash_out` (the same
  burn and payout, through a shared `pay_out_wrapper`, into the saver's own
  wallet, plus a fresh USDC escrow), the sale, then `settle_cash_out`, which
  measures the escrow, holds it to the minimum the saver signed, pays them
  and closes everything. It reuses the buy's introspection (`scan_pair_transaction`),
  so it cannot settle without its begin, begin cannot land without its settle,
  neither can be reached by CPI, and no other paritas instruction can share
  the transaction.

The threat model differs from a buy, deliberately. A buy's caller is an
untrusted third party spending the saver's delegated money; a cash out's
signer is the person being paid. The vault's exposure ends at
`begin_cash_out`, exactly as in `withdraw`. The escrow and settle protect the
saver from a bad route or a short fill, so the saver's own minimum is the
right one to enforce.

**Devnet.** The sale is a substitute, marked with the same DEVNET SUBSTITUTE
banner as the keeper's buy: the saver's wrapper goes to a liquidity key and
the liquidity key's USDC goes into the escrow. That key must sign its own
transfer, so `/api/cash-out` builds the transaction, co-signs its part and
returns it for the saver to sign: still one transaction and one prompt. The
co-signature covers the whole message, so nothing in it can be altered, and
the saver pays every fee and rent. On mainnet the sale is a Jupiter route the
saver signs alone, and the route is not needed.

A cash out sells through one wrapper, since the program allows one begin per
transaction; the screen says the most one cash out can take when that binds.

Which wrapper pays is decided by `planPayout` in `src/lib/paritas.ts` and never
shown: the one holding the most, if it covers the whole amount, otherwise a
split across wrappers in one transaction. The preview repeats the program's
integer conversion exactly, so the number on the button is the number that
lands; `npm run verify` checks that to the raw unit. If the vault as a whole
cannot pay, the screen says how much it can, before any transaction.

## The dashboard

Shares owned stays the hero: it only moves when the saver buys or takes out,
never with the market. Under it, "Worth today" gives the value at the latest
price, what was put in, and the change in dollars and percent. The change is
a word, "Up" or "Down", in the same ink either way. Nothing turns red, the card
looks the same on a green day and a red one, and its one reassuring line is
always there rather than appearing when prices fall.

Prices are Pyth's underlying equity feeds, `Equity.US.NVDA/USD` and
`Equity.US.SPY/USD`, never the per wrapper feeds. The ids are verified in
CONTEXT.md and again by `setup-devnet.ts` against Pyth's feed list, then
carried in the address book. `/api/prices` reads them server side with
`PYTH_API_KEY`; since 2026-08-26 Hermes has no keyless price reads, and the
sponsored on chain accounts for these feeds stopped updating that day. The
feeds follow US market hours, so every value carries its age ("Prices as of
Fri 4:00 PM").

"Put in" is at average cost for the shares still held, so taking half the
shares out halves it rather than showing a loss. Shares added outside any plan
have no cost on chain; they count toward value and are left out of the change,
and the card says so. `src/lib/portfolio.ts` has all of it, in integer math.

The streak is consecutive buys, from chain history: the successful
transactions on each plan's execution receipt address, which nothing but that
plan's buys touches (`npm run verify` checks this against every plan's own
count). A buy counts as consecutive unless a whole period was missed before
it, and the streak ends once the live plan is a whole period overdue.

## Changing a plan

There is no update instruction. Changing a plan cancels it and creates a new
one, funded afresh, in one transaction, and can move a plan to the other
asset the same way. A new amount needs a new approval anyway, and one
transaction means there is never a moment with two plans live or none. The next buy keeps its date, pulled in if the new cadence is shorter.

Each change leaves the old plan's account in place (cancel does not close it)
and uses the next plan slot, so it costs account rent that is not returned,
and an owner has 256 slots in total on a vault.

## Running it

```bash
npm install
npm run dev          # copies devnet.json and the IDL in first
```

Needs a browser wallet on devnet with some devnet USDC. Wallets are discovered
through the Wallet Standard, so no adapter packages are bundled.

## Verifying against devnet

The browser wallet cannot be clicked through from CI, so the test drives the
app's own chain library instead, headlessly, with a local keypair standing in
for the wallet:

```bash
ANCHOR_WALLET=~/.config/solana/id.json npm run verify
```

It exercises every function the UI calls, in the order the UI calls them:
load plans, read holdings, check the funding block, cancel, create, re-read,
and assert the delegation landed and now blocks a second plan. Then it moves
the plan to the second asset, and takes 0.1 of a share out, checking the
wallet received exactly the raw amount the preview computed. Last it cashes
out 0.1 of a share, checking the dollars received match the quote to the
unit, after first proving that a sale one unit short of the signed minimum
reverts with the shares untouched. It also asserts
the headline sentence contains no wrapper name, multiplier or basis point.

What that leaves untested is the wallet adapter handing back a signature.

## Deploying to Vercel

Set the project's **Root Directory** to `app`. Vercel clones the whole repo, so
`prebuild` can still reach `../devnet.json` and `../target/idl/paritas.json`.

| Variable | Required | Scope | Meaning |
| --- | --- | --- | --- |
| `RPC_URL` | yes | server only | The real RPC endpoint. Never reaches the browser. |
| `NEXT_PUBLIC_RPC_URL` | no | **public** | Bypasses the proxy and connects direct. Only for an endpoint with no key in it. |
| `PYTH_API_KEY` | for prices | server only | Pyth Hermes key, sent as `Authorization: Bearer`. Without it the dashboard shows shares and money put in, and says today's value is unavailable. |
| `PYTH_HERMES_URL` | no | server only | Defaults to `https://pyth.dourolabs.app/hermes`. |
| `CASH_OUT_LIQUIDITY_KEY` | for devnet cash out | server only, **Sensitive** | Secret key (JSON array) of the devnet liquidity key named in `devnet.json`. Any other key is refused. Without it, cash out says it is unavailable; taking shares still works. |
| `CASH_OUT_QUOTE_USDC_PER_SHARE` | no | server only | Devnet sell price, default `5`, matching the keeper's buy quote. `CASH_OUT_QUOTE_<SYMBOL>` overrides per asset. |

### Why the key is not a `NEXT_PUBLIC_` variable

`NEXT_PUBLIC_` does not mean "a variable the app uses". It means "a value
compiled into the JavaScript every visitor downloads". A provider url with an
api key in it, set that way, is readable by anyone who opens devtools, and
keeping it out of git changes nothing about that.

So the browser talks to `/api/rpc` on this app's own domain, and that route
forwards to `RPC_URL` from the server. The key never leaves the server.

Two consequences worth knowing:

- **`sync-config.mjs` strips `rpcUrl` out of the app's copy of the address
  book.** That file is imported by client code, so the field would otherwise
  ship to the browser and quietly undo the proxy the next time the environment
  was rebuilt against a keyed endpoint.
- **Confirmation polls over HTTP** rather than using
  `connection.confirmTransaction`, which subscribes over a websocket. There is
  no websocket through an HTTP proxy, so that call would wait forever. See
  `confirmSignature` in `src/lib/paritas.ts`.

Set `NEXT_PUBLIC_RPC_URL` only for a genuinely public endpoint, where the
extra hop buys nothing.

Redeploy whenever `devnet.json` changes; the addresses are baked in at build.

### `.vercelignore`

Without it the CLI falls back to `.gitignore`, which excludes
`src/config/*.json`. Those are generated rather than authored, but they are
real build inputs, and the files they come from live outside `app/` and are
never uploaded when `app/` is the deploy root. `.vercelignore` excludes only
build output so the generated copies ship.

## Motion

Spring transitions throughout, no durations or easing curves. `useSpring`
drives the share counter so it ticks up rather than jumping. `layout` handles
the plan card expanding into its detail view. `AnimatePresence` covers screen
enter and exit. `useReducedMotion` is respected everywhere: when it is set, the
counter snaps to its value and transitions collapse, rather than playing
slower.
