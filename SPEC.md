# Investire: recurring equity savings on Solana, built on Paritas

## The product
A person whose local currency is losing value holds stablecoins that legally
cannot pay them yield. They set one schedule: $5 every Friday into NVIDIA. It
runs automatically until they stop it. Balance is shown in shares owned first,
dollars second.

## Why Solana specifically
A $5 recurring equity buy is economically impossible at a brokerage, fees eat
it. On Solana it costs a fraction of a cent. Recurring micro-investing in
equities cannot exist anywhere else. Capability claim, not a speed claim.

## Why Paritas is required, not decorative
The same company is tokenized by multiple issuers. Circle alone is $171M split
across Ondo's CRCLON ($130M) and xStocks' CRCLX ($41M). Each wrapper carries
dividend value in a Token-2022 ScaledUiAmount multiplier that no naive
integration reads, and the wrappers drift apart.

A savings product buying "one share of NVIDIA" weekly must know NVDAx and
NVDAon are the same underlying at different multipliers, or its balances are
wrong and it is locked to whichever wrapper it hardcoded.

Balances are denominated in EQUITY UNITS, not raw tokens.

## Reuse from existing Paritas code
- multiplier.rs unchanged
- Vault, Wrapper, deposit, withdraw, equity-unit accounting
- to_equity_units / from_equity_units

## Demote, do not delete
register_pair, get_rate, swap, add_liquidity, remove_liquidity stay in the
program and stay deployed. They are the primitive Investire builds on. They
come off the product surface only.

## New state
Schedule PDA, seeds [b"schedule", owner, vault, schedule_index]:
owner, vault, amount_usdc, cadence_seconds, next_due_ts, executions,
total_usdc_spent, total_equity_units, active, bump

## New instructions
1. create_schedule(amount_usdc, cadence_seconds, first_run_ts)
   Owner signs. Cadence at least 1 hour, amount above a dust floor.
2. cancel_schedule
   Owner signs. Sets active false. Holdings untouched.
3. execute_schedule, PERMISSIONLESS
   Anyone may call on a due schedule and earns a small USDC fee. Our keeper is
   the default, not a dependency.

## Trust model on execute_schedule
Jupiter cannot be CPI'd with dynamic routing, so the swap is a separate
instruction in the same transaction assembled by the keeper. Our program runs
last and verifies what happened. The caller is untrusted.

Transaction shape:
  [0] begin_execution   pulls amount_usdc from owner's delegated allowance
  [1] Jupiter swap      USDC to a registered wrapper mint of this vault
  [2] settle_execution  verifies and credits

settle_execution must verify and error on any failure:
- schedule.active is true
- now >= schedule.next_due_ts
- destination mint is a wrapper registered on this vault
- raw amount actually received, converted to equity units at the live
  multiplier, is at least min_equity_units passed by the caller
- receiving token account is owned by the vault PDA
- credit goes to schedule.owner, never to the caller
- instruction introspection confirms begin_execution ran in this same
  transaction and the debited amount matches

Then advance next_due_ts, increment counters, pay the caller fee.

## Vaults for the demo
NVDA vault, two wrappers:
  NVDAx  Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh  decimals 8
  NVDAon gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo  decimals 9
SPY vault, one wrapper:
  SPYx   XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W  decimals 8

## Frontend
Reads as a savings app, not a DeFi dashboard.
- SHARES OWNED in the hero position. Dollar value secondary. Shares only go up
  when you buy weekly, dollar value bounces, and this app must not feel awful
  on a red day.
- "You save $5 every Friday. You own 0.0241 shares of NVIDIA."
- Schedule setup in under three taps. Mobile-first.
- No multipliers, no basis points, no raw token amounts in the UI.
- Motion (package: motion, import from motion/react) for animation.
  Spring transitions, layout transitions, useSpring for the share counter,
  useReducedMotion respected.

## Keeper
Stateless Node service on the Frankfurt droplet. Reads due schedules, builds
the three-instruction transaction, submits. A convenience, not a dependency.

## Out of scope for v1
Spending from the portfolio. Multi-asset allocation. Fiat off-ramp.

## Rules
Build with cargo build-sbf --tools-version v1.57. Never anchor build.
Integer fixed-point only after the single f64 read.
No em dashes or en dashes anywhere, code or copy.
Never invent an address. Verified values live in CONTEXT.md.
