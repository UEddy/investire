# Recurring equity savings on Solana, with Paritas underneath

## The product
A person in a country with a depreciating currency holds stablecoins that
legally cannot pay them yield. They set up a schedule: $5 every Friday into
NVIDIA. It executes automatically, forever, until they stop it. Their balance
is shown in dollars and in shares, never in raw token amounts.

## Why Solana specifically
A $5 recurring buy is economically impossible at a brokerage. Fees consume it.
On Solana it costs a fraction of a cent. Recurring micro-investing in equities
cannot exist anywhere else. That is a capability claim, not a speed claim.

## Why Paritas is required, not decorative
The same company is tokenized by multiple issuers. Circle alone is $171M split
across Ondo's CRCLON ($130M) and xStocks' CRCLX ($41M). Each wrapper carries
its dividend value in a Token-2022 ScaledUiAmount multiplier that no naive
integration reads, and the wrappers' multipliers drift apart.

So a savings product that buys "one share of NVIDIA" every week has to know
that NVDAx and NVDAon are the same underlying at different multipliers, or its
balances are wrong and it is locked to whichever wrapper it hardcoded.

Balances are therefore denominated in EQUITY UNITS, not raw tokens. A schedule
can buy whichever wrapper has liquidity that day and the balance stays correct.

## Carries over from existing Paritas code
- multiplier.rs, unchanged. The reader, effective-timestamp selection, and the
  f64-to-u128 fixed point conversion.
- The Vault, Wrapper, deposit and withdraw instructions. Equity-unit accounting.
- to_equity_units / from_equity_units.

## Delete
- register_pair, get_rate, swap, add_liquidity, remove_liquidity.
- The Pair state. The swap pools.
Keep them in git history, remove from the program.

## New state

Schedule PDA, seeds [b"schedule", owner, vault, schedule_index]:
- owner: Pubkey
- vault: Pubkey            (which underlying this buys)
- amount_usdc: u64         (per execution)
- cadence_seconds: i64     (604800 for weekly)
- next_due_ts: i64
- executions: u32
- total_usdc_spent: u64
- total_equity_units: u128
- active: bool
- bump: u8

## New instructions

1. create_schedule(amount_usdc, cadence_seconds, first_run_ts)
   Creates the Schedule. Owner signs. Validates cadence is at least 1 hour and
   amount is above a dust floor.

2. cancel_schedule
   Owner signs. Sets active false. Does not touch holdings.

3. execute_schedule
   PERMISSIONLESS. Anyone may call it on a schedule that is due, and earns a
   small fee in USDC for doing so. The default keeper is ours, but the product
   does not die if our keeper does.

   The caller is untrusted. The program validates the outcome, it does not
   trust the caller to have behaved.

## The trust model on execute_schedule

Jupiter cannot be called from inside a program with dynamic routing, so the
swap happens as a separate instruction in the same transaction, assembled by
the keeper. Our program runs last and verifies what actually happened.

Transaction shape:
  [0] our program: begin_execution   pulls amount_usdc from owner's delegated
                                     allowance into a program-owned temp
  [1] Jupiter swap: USDC -> a registered wrapper mint of this vault
  [2] our program: settle_execution  verifies and mints receipt

settle_execution MUST verify, and error on any failure:
- schedule.active is true
- now >= schedule.next_due_ts
- the destination mint is a wrapper registered on this vault
- the wrapper's raw amount actually received, converted to equity units using
  its live multiplier, is at least min_equity_units passed by the caller
- the receiving token account is owned by the vault PDA
- the receipt is minted to schedule.owner, not to the caller

Use instruction introspection (the instructions sysvar) in settle_execution to
confirm begin_execution ran in this same transaction and that the amount
debited matches. This is what stops a caller from settling without paying.

Then: advance next_due_ts by cadence_seconds, increment counters, pay the
caller fee.

## Vaults to register for the demo
- NVDA vault, two wrappers:
    NVDAx  Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh  decimals 8
    NVDAon gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo  decimals 9
- SPY vault, one wrapper:
    SPYx   XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W  decimals 8
  Single-wrapper vault proves the architecture generalises.

## Frontend
Must read as a savings app, not a DeFi dashboard.
- Balance in dollars first, shares second. Never raw token amounts.
- "You save $5 every Friday. You own 0.0241 shares of NVIDIA."
- Set up a schedule in under three taps.
- Mobile-first layout.
No charts of multipliers. No basis points anywhere in the user-facing UI.

## Keeper
Small stateless Node service on the Frankfurt droplet. Reads due schedules,
builds the three-instruction transaction, submits. 512MB is ample.
It is a convenience, not a dependency. Say so in the video.

## Out of scope for v1
Spending from the portfolio. Multi-asset allocation. Withdrawals to fiat.
One sentence at the end of the pitch about where it goes next, no code.

## Rules
Build with cargo build-sbf --tools-version v1.57. Never anchor build.
Integer fixed-point only after the single f64 read.
No em dashes or en dashes anywhere.
Never invent an address. Everything verified is in CONTEXT.md.
