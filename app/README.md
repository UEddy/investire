# Investire

A savings app. You put in a few dollars a week and you own shares.

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
2. Pick an amount
3. Confirm

One wallet approval, because creating the plan and funding it are instructions
in a single transaction. Stopping is one tap and one approval, and revokes the
delegation in the same transaction so nothing can move your money afterwards
even if the program were wrong about that.

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
and assert the delegation landed and now blocks a second plan. It also asserts
the headline sentence contains no wrapper name, multiplier or basis point.

What that leaves untested is the wallet adapter handing back a signature.

## Deploying to Vercel

Set the project's **Root Directory** to `app`. Vercel clones the whole repo, so
`prebuild` can still reach `../devnet.json` and `../target/idl/paritas.json`.

| Variable | Required | Scope | Meaning |
| --- | --- | --- | --- |
| `RPC_URL` | yes | server only | The real RPC endpoint. Never reaches the browser. |
| `NEXT_PUBLIC_RPC_URL` | no | **public** | Bypasses the proxy and connects direct. Only for an endpoint with no key in it. |

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
