# Investire

> **For Stocklana judges.** Investire is a recurring savings plan that buys
> tokenized stocks on Solana with USDC, automatically, at whatever pace and
> amount you choose.
>
> - Live demo: <https://investire.vercel.app>
> - Pitch video: [URL]
> - Technical video: [URL]
> - Every number and how to check it: [SOURCES.md](SOURCES.md)

Investire makes recurring USDC buys of tokenized stocks. Balances are held as
equity units read from Token-2022 scaled UI multipliers, so a balance stays
correct whether a buy landed in NVDAx or NVDAon. On devnet the keeper runs the
three-instruction buy against mock wrappers carrying real mainnet multipliers,
and prices are fixed at a $5 test price until Pyth is live.

### What's simulated on devnet

The program, vaults, equity unit conversions, plans, delegations, withdrawals,
cash outs, keeper and app are real and running. These stand in for what
devnet lacks, each detailed in
[SOURCES.md, section 8](SOURCES.md#8-what-is-substituted-on-devnet-and-what-replaces-it-on-mainnet):

- [Mock wrapper mints](SOURCES.md#mock-wrapper-mints) carrying the real
  mainnet multipliers, checked against CONTEXT.md on every setup run.
- [An inventory transfer](SOURCES.md#the-buy-swap-leg) standing in for the
  Jupiter swap.
- [A fixed $5 price](SOURCES.md#the-price-quote) per share while the Pyth key
  is pending.
- [A cash-out co-signer](SOURCES.md#the-cash-out-sale-leg), a devnet
  liquidity key that signs its own transfer, which a real route would not
  need.

## What it is

It is built for people who hold dollars in stablecoins because their own
currency is losing value, and who have no broker willing to take them. You set
an amount and a pace, and it buys shares automatically until you stop.

## Why this belongs on Solana

A five dollar recurring equity buy is not a thing a brokerage can sell you. It
is not a policy choice, it is arithmetic: a one dollar commission on a five
dollar buy is twenty percent, before spread, before custody, before the
minimum balance most brokers ask for in the first place. The order costs more
to handle than it is worth, so the product does not exist, and the people who
most need to escape a falling currency are the ones told to come back with
more money.

On Solana the same buy pays a base network fee of 5,000 lamports, which is
0.000005 SOL, plus whatever priority fee the moment calls for. This project
adds a keeper fee of 25 basis points with a floor of five cents, so a five
dollar buy costs five cents to execute and a plan is viable at two dollars
fifty, which is the smallest plan the program accepts.

That is a capability claim, not a speed claim. Nothing here needs to be fast.
It needs to be cheap enough that a small, regular, automatic buy is worth
making at all.

## What is underneath

The same company is tokenized by more than one issuer. Each wrapper carries
its accumulated dividend value in a Token-2022 scaled UI amount multiplier
stored on the mint, and those multipliers have drifted apart, because the
issuers withhold tax differently and reinvest at different prices. A naive
integration reads the raw token amount, or reads the field named `multiplier`
without checking whether a newer one has already taken effect, and is wrong by
the drift on every balance it shows.

So Investire never holds balances as token counts. Every buy is converted, as
it lands, into equity units: the token amount at that wrapper's own live
multiplier, normalised for its decimals, at nine decimal places. A plan can
buy whichever wrapper actually has liquidity that day, and the saver's balance
stays correct either way. A withdrawal converts back, at the multiplier of
whichever wrapper pays it out.

Every number behind that, the live multipliers, the drift between wrappers,
the stale field on one of the mints, the feed ids, with the commands to check
each one yourself, is in **[SOURCES.md](SOURCES.md)**. It is not repeated here.

## Try it

It runs on Solana **devnet**, so everything you spend is test money and nothing
is a real share.

**1. Get a wallet.** Install Phantom or Solflare, then switch it to devnet:
both keep that under developer or testnet settings, where you pick Solana
Devnet as the network. The app itself asks for nothing but a connection, and
any Wallet Standard wallet works, since no adapter packages are bundled.

**2. Get devnet SOL**, which pays transaction fees. Either use
<https://faucet.solana.com> with your wallet address, or, with the Solana CLI
installed, run `solana airdrop 2 <your address> --url devnet`. Two SOL is far
more than you will need.

**3. Get devnet USDC**, which is what your plan spends. Use Circle's faucet at
<https://faucet.circle.com>: choose Solana Devnet, paste your wallet address,
and it sends test USDC. The mint the app uses is
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, which is Circle's own devnet
USDC, not a mock of ours.

**4. Open <https://investire.vercel.app>**, connect, and start a plan. Pick an
asset, NVIDIA or the S&P 500; pick daily, weekly or every 30 days; type any
amount from two dollars fifty upward. One wallet approval creates the plan and
funds it for twelve buys, and the screen tells you exactly how much it is then
allowed to take. Stopping is on the plan card, takes one tap and a
confirmation, and removes that permission in the same transaction.

A few honest notes for a visitor. Buys are made by a keeper service, so a plan
due now is bought within a minute or two rather than instantly. Today's market
value is not shown: the Pyth key this deployment uses is not yet activated, so
the dashboard shows your shares, what you put in, and your streak, and says
value is unavailable. Cashing out to USDC works, at a fixed devnet price of
five dollars a share, which is the same price the devnet keeper buys at.

## Correctness layer

**The three instruction pattern.** One buy is one transaction holding exactly
three of our instructions in order: `begin_execution` pulls the buy from the
saver's delegated allowance and opens a fresh escrow, a swap delivers the
wrapper into that escrow, and `settle_execution` measures what arrived, values
it, credits the saver and pays the executor. Cashing out is the same shape in
reverse: `begin_cash_out`, a sale, `settle_cash_out`.

**Why the swap cannot be a CPI.** The instructions sysvar lists only top level
instructions. Anything reached by a cross program invocation is invisible to
it, so a paritas instruction smuggled in under a CPI could never be counted by
the scan that is supposed to bound what is in the transaction. Both ends
therefore check that they are themselves the top level instruction the scan
found, and the swap sits between them as a plain top level instruction. A
transaction that wraps the pattern inside another program fails rather than
being trusted on a proof about somebody else's instructions.

**The executor is untrusted and permissionless.** Anyone may run a schedule
that is due. Signing one buys nothing except the right to pay the rent and
collect the fee, and every value an executor could otherwise choose is pinned
at creation time, when the saver signed: the vault, the payment mint, the
account debited, the amount, the pace. The minimum shares an execution must
deliver is the saver's, stored on their schedule; the figure the executor
passes can only tighten it, never loosen it. A keeper that disappears makes a
plan late, not lost, because the next caller can run it.

**A fresh escrow per execution.** The swap could deliver straight into the
vault's own token account, and the program would still be able to check the
account's owner. What it could not do is answer the only question that
matters: how much arrived because of *this* swap. A shared balance also moves
for a concurrent deposit, for another schedule's execution, for a transfer
somebody put earlier in the same transaction, and for a deposit reached by a
CPI the scan cannot see. So the destination is a token account derived from
the schedule, created in this transaction and closed at the end of it. Its
balance at settle time is exactly what this transaction delivered, with no
before and after subtraction and no snapshot to trust.

**Instruction introspection.** Before either end will act, it walks every top
level instruction in the transaction and requires that the paritas
instructions present are exactly one begin and one matching settle, in that
order, and nothing else of ours. A second begin, a stray withdraw alongside an
execution, a settle without its begin: all rejected. The strictness is what
makes an execution assembled by a stranger safe to land, and the price is that
a keeper cannot batch two schedules into one transaction.

**Stale prices are skipped, not used.** Deliveries are sized from a price
feed, and the feeds for US equities stop moving at the close. A price older
than a minute, or with a confidence interval wider than one percent of the
price, is refused: the run is logged and left due, and retried until the price
is live again. Buying at Friday's close on a Sunday is exactly the quietly
wrong scheduled buy this project exists to prevent. The cost is timing, not
money: a plan due on a Saturday buys at Monday's open, and it does not buy
twice to catch up, because a settled execution moves the next due date a full
period past the late buy. On devnet today the keeper is on the flat price
substitute below, so this check is built and tested but dormant until the Pyth
key is live.

## Build and run

Pinned versions: Rust 1.89.0 (`rust-toolchain.toml`), Solana platform tools
v1.57, anchor-lang and anchor-spl 0.32.1 with the `token_2022` feature, Rust
edition 2021, anchor-cli 0.32.1, solana-cli 2.3.0, Node v24.10.0.

```bash
# program
cd programs/paritas
cargo build-sbf --tools-version v1.57
solana program deploy target/deploy/paritas.so          # from the repo root
anchor idl build -p paritas -o target/idl/paritas.json

# devnet environment: mock mints, vaults, wrappers, keeper inventory
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json npm run devnet:setup

# the app
cd app && npm install && npm run dev

# the whole flow against devnet, headless, no browser wallet
cd app && ANCHOR_WALLET=~/.config/solana/id.json npm run verify

# the keeper
npm run keeper:build && npm run keeper:start        # see keeper/README.md for env
```

**`anchor build` does not work here** and must not be used. Its bundled
platform tools v1.48 ship rustc 1.84.1, which cannot parse dependencies that
require edition2024. `cargo build-sbf --tools-version v1.57` uses a new enough
toolchain. `anchor idl build` is fine, because it compiles on the host
toolchain rather than the SBF one.

More detail lives next to the code it describes: `app/README.md` for the
product surface and deployment, `keeper/README.md` for the service, `SPEC.md`
for the program's specification, `CONTEXT.md` for verified on chain values,
and `SOURCES.md` for how to check any claim here.

## What is next

**Jupiter routes replace both substitutes.** On mainnet the keeper's delivery
becomes a Jupiter route into the execution escrow, and a cash out becomes a
route into the cash out escrow signed by the saver alone. In both cases that
is one instruction changing and nothing else: the program never inspects the
swap, only what arrived.

**Pyth as the anchor that closes the floor drift.** A schedule's minimum
shares ratchets to each execution's realised result less a tolerance, which
bounds how far a single execution can be shorted but not the total: an
executor who shorts every run by the full tolerance walks the floor down
geometrically, and with no external reference there is nothing to stop it.
That limit is documented in the `Schedule` comment in
`programs/paritas/src/state.rs`. A live price gives the floor something to be
anchored to rather than only to its own history, which closes the gap.

**Multiple concurrent plans.** An SPL token account holds exactly one
delegate, so funding a second plan from the same dollar account would silently
strip the first. Today the app allows one plan at a time and says so. A
per plan payment account, or a delegation the program owns, lifts it.

**More assets.** Adding one is a vault and an entry in the setup script; the
app reads what exists from the address book and needs no change.
