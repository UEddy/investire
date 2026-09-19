# Investire keeper

Polls for `Schedule` accounts that are `active` with a `next_due_ts` in the
past, and submits one execution transaction for each:

```
[0] ComputeBudget
[1] begin_execution    pulls the buy from the owner's delegation, withholds the fee
[2] swap               DEVNET SUBSTITUTE for a Jupiter route, see below
[3] settle_execution   verifies the delivery, credits the owner, pays the fee
```

One schedule per transaction. `settle_execution`'s introspection requires the
transaction to hold exactly one `begin_execution` and one `settle_execution`
and no other paritas instruction, so batching two schedules would be rejected
on chain. Giving up batching is what buys the verification.

The service is stateless. Everything it needs is in `devnet.json`, in the
environment, or on chain, so restarting it loses nothing and two of them
running at once is safe: the second one's execution fails on `ScheduleNotDue`
and the schedule advances exactly once.

## The swap leg is a devnet substitute

Instruction `[2]` is not a swap; it is inventory delivered at a Pyth-quoted rate. Jupiter is not on devnet and no venue makes a
market in the mock mints, so the keeper delivers wrapper tokens out of its own
inventory into the execution escrow and keeps the USDC. That is the position a
keeper ends a real execution in anyway.

The program never inspects that instruction. `settle_execution` measures the
escrow balance, values it at the live multiplier and checks it against the
schedule's floor, and would do that whether the tokens came from Jupiter,
another aggregator, or inventory. To go to mainnet, replace that one
instruction with the Jupiter swap, destination `escrowPda`, and change nothing
else.

Because of the substitute, the keeper must hold wrapper inventory. It skips any
schedule it cannot cover, with a reason in the log, rather than submitting a
transaction it knows will fail.

## Configuration

All from the environment. Nothing is committed.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `KEEPER_RPC_URL` | yes | | RPC endpoint |
| `KEEPER_KEYPAIR` | yes | | Path to the keeper's keypair json |
| `PARITAS_ADDRESS_BOOK` | no | `./devnet.json` | Address book from `scripts/setup-devnet.ts` |
| `PARITAS_IDL` | no | `./target/idl/paritas.json` | Anchor IDL |
| `KEEPER_POLL_SECONDS` | no | `60` | Poll interval |
| `PYTH_API_KEY` | yes | | Hermes key for price reads. Never committed. |
| `PYTH_HERMES_URL` | no | `https://pyth.dourolabs.app/hermes` | Hermes base |
| `KEEPER_MAX_PRICE_AGE_SECONDS` | no | `60` | Older prices are not traded on |
| `KEEPER_MAX_CONFIDENCE_PERCENT` | no | `1` | Wider confidence is not traded on |
| `KEEPER_CONFIRM_TIMEOUT_SECONDS` | no | `60` | Longest wait on one confirmation |

Every vault in the address book is served, each delivering its own first
wrapper. `scripts/setup-devnet.ts` stocks the keeper with 100 of each, reading
the keeper's public key from `KEEPER_PUBKEY` or `.devnet-keys/keeper.json`.
`KEEPER_WRAPPER` and `KEEPER_QUOTE_*` are no longer read.

## Prices, and why stale ones are skipped

Each delivery is sized from Pyth's price for the underlying,
`Equity.US.NVDA/USD` or `Equity.US.SPY/USD`: the buy less the keeper fee,
divided by the price, is the number of shares delivered, converted to wrapper
at the wrapper's own multiplier. So the saver's cost basis is what the shares
cost at the time.

Those feeds only move during US market hours. A price older than a minute is
not traded on: the run is logged and left due, and retried every poll until
the price is live. Buying at Friday's close on a Sunday would be exactly the
quietly wrong scheduled buy this project exists to prevent. The cost is
timing: a plan due on Saturday buys at Monday's open. It does not buy twice
to catch up, because the next due date moves a full period past the late buy.

```
WARN  skip 8VZQ...: price is 3d old, market likely closed; leaving it due
INFO  executed 8VZQ... price=765.479260 priceAge=2s ... equity=0.003200606 SPY
```

Confirmation is by polling `getSignatureStatuses` over HTTP, never a
websocket, and every wait is bounded by `KEEPER_CONFIRM_TIMEOUT_SECONDS`.
| `KEEPER_COMPUTE_UNIT_LIMIT` | no | `400000` | Introspection plus several CPIs |

No addresses are configured. They all come from the address book.

## Deploying to the droplet

A 512MB Ubuntu box. Build locally, ship the compiled JS: no Rust toolchain and
no TypeScript compile on the droplet.

**1. Build locally**

```bash
yarn install
yarn keeper:build          # tsc -> dist/
```

**2. Create the user and directories**

```bash
ssh root@droplet
adduser --system --group --no-create-home investire
mkdir -p /opt/investire /etc/investire
```

**3. Ship the code and the two json files**

```bash
# from the repo root, locally
rsync -a --delete dist/ root@droplet:/opt/investire/dist/
rsync -a package.json yarn.lock root@droplet:/opt/investire/
rsync -a devnet.json root@droplet:/opt/investire/
rsync -a target/idl/paritas.json root@droplet:/opt/investire/idl/paritas.json
```

`devnet.json` and the IDL are the only two files the keeper reads. Ship a new
`devnet.json` whenever the environment is rebuilt.

**4. Install production dependencies on the droplet**

```bash
ssh root@droplet
cd /opt/investire
yarn install --production --frozen-lockfile
chown -R investire:investire /opt/investire
```

**5. Install the keypair and the environment file**

The keypair never goes in the repo. Copy it out of band:

```bash
scp .devnet-keys/keeper.json root@droplet:/etc/investire/keeper.json
ssh root@droplet 'chown investire:investire /etc/investire/keeper.json && chmod 600 /etc/investire/keeper.json'
```

Then `/etc/investire/keeper.env`, mode 0600, owned by root:

```ini
KEEPER_RPC_URL=https://api.devnet.solana.com
KEEPER_KEYPAIR=/etc/investire/keeper.json
PARITAS_ADDRESS_BOOK=/opt/investire/devnet.json
PARITAS_IDL=/opt/investire/idl/paritas.json
KEEPER_POLL_SECONDS=60
```

```bash
chmod 600 /etc/investire/keeper.env
```

The public devnet endpoint drops requests often enough to be visible in the
log. A dedicated RPC provider is worth it before anyone else relies on this.

**6. Fund the keeper**

It needs SOL for fees and for the escrow and execution receipt rent, both of
which come back when `settle_execution` closes them. It also needs wrapper
inventory, for as long as the swap leg is the devnet substitute.

**7. Start it**

```bash
cp keeper/investire-keeper.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now investire-keeper
journalctl -u investire-keeper -f
```

## Reading the log

One line per event.

```
2026-09-18T11:07:40.954Z INFO  polling every 15s, active flag at byte 211
2026-09-18T11:07:46.276Z INFO  1 schedule(s) due
2026-09-18T11:07:48.700Z INFO  executed C1Tkk... owner=4Uatg... amount=5.000000 USDC equity=1.001701196 NVDA fee=0.050000 USDC sig=5GoKu...
```

`fee` is the keeper's actual earnings, not the debit. `begin_execution` also
moves the rest of the buy to the keeper as swap funding, which a real keeper
spends at Jupiter.

Skips are expected and are not errors:

```
WARN  skip C1Tkk...: owner has not delegated this schedule on their payment account
WARN  skip C1Tkk...: quote of 0.85 shares is below the schedule floor of 0.90
```

The keeper checks the owner's balance, their delegation, its own inventory and
the floor before submitting, so these cost nothing. One schedule failing never
stops the others.

## Operational notes

- **Restarts are free.** Stateless, and an execution is atomic on chain. Being
  killed mid transaction loses nothing.
- **Retries are not uniform.** Failures that provably did not execute
  (transport errors, `Blockhash not found`) are retried. Ambiguous ones
  (`block height exceeded`) are only retried where a second run is a no-op,
  which an execution is not. A duplicate would be caught on chain by
  `next_due_ts` having moved, but the keeper reports it and re-reads the
  schedule on the next poll instead of guessing.
- **One delegate per token account.** SPL `approve` holds a single delegate, so
  an owner running several schedules at once needs a separate payment account
  per schedule. `Schedule` pins `owner_payment_account`, so that works.
- **The `active` byte offset is read from the IDL** at startup and logged. It
  is not hardcoded, so adding a field to `Schedule` either keeps working or
  fails loudly instead of silently matching the wrong byte.
