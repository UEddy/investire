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
| `KEEPER_POLL_SECONDS` | no | `60` | Poll interval, ignored with `--once` |
| `KEEPER_ONCE` | no | | Set for a single pass, same as `--once` |
| `KEEPER_PRICE_SOURCE` | no | `flat` | `flat` or `pyth` |
| `KEEPER_QUOTE_USDC_PER_SHARE` | no | `5` | The flat price per share |
| `PYTH_API_KEY` | when `pyth` | | Hermes key for price reads. Never committed. |
| `PYTH_HERMES_URL` | no | `https://pyth.dourolabs.app/hermes` | Hermes base |
| `KEEPER_MAX_PRICE_AGE_SECONDS` | no | `60` | Older prices are not traded on |
| `KEEPER_MAX_CONFIDENCE_PERCENT` | no | `1` | Wider confidence is not traded on |
| `KEEPER_CONFIRM_TIMEOUT_SECONDS` | no | `60` | Longest wait on one confirmation |

Every vault in the address book is served, each delivering its own first
wrapper. `scripts/setup-devnet.ts` stocks the keeper with 100 of each, reading
the keeper's public key from `KEEPER_PUBKEY` or `.devnet-keys/keeper.json`.
`KEEPER_WRAPPER` is no longer read.

## Prices, and why stale ones are skipped

**Status:** Pyth pricing is integrated and awaiting key activation. The
project's key is set but Hermes answers 403, so the keeper defaults to a flat
price (`KEEPER_PRICE_SOURCE=flat`, 5.00 a share). Everything below applies
once it is set to `pyth`.

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

## Running one pass

`--once` makes one sweep over everything due and exits, instead of polling
forever. `KEEPER_ONCE` does the same for a caller that finds an environment
variable easier than an argument.

```bash
npm run keeper:build
KEEPER_RPC_URL=... KEEPER_KEYPAIR=... node dist/keeper/index.js --once
```

The exit status is the whole point of the mode, so it is worth being exact
about it. It is non-zero only when the run could not do its job:

- **Nothing due**: exit 0. This is the ordinary outcome of a five minute
  schedule and is not a failure.
- **Schedules executed**: exit 0.
- **Schedules skipped**: exit 0. A skip is an unusable price, a buy too small
  to round to shares, or an owner who cannot currently pay. None is the
  keeper's fault and all are still true or not next time.
- **A schedule failed on its own terms**: exit 0, counted and logged. A revoked
  delegation or a spent balance would otherwise keep the job red until that one
  owner acted, which teaches everyone to ignore a red job.
- **The pass could not run at all**: exit 1. A missing variable, an unreadable
  keypair, an address book that disagrees with the IDL, or an RPC that stayed
  unreachable past the retries.

Every run logs one summary line, `N executed, N skipped, N failed of N due`, so
a green run that is quietly doing nothing is still visible as one.

## Running on GitHub Actions

`.github/workflows/keeper.yml` replaces the droplet. It runs `--once` every
five minutes, which is the shortest interval GitHub accepts; scheduled runs are
queued on shared capacity and are often late, which is survivable here because
a schedule whose keeper is late is late rather than lost.

Two secrets, both under **Settings, Secrets and variables, Actions,
Repository secrets** in this repository:

| Secret | Contents |
| --- | --- |
| `KEEPER_KEYPAIR` | The keeper keypair **json array itself**, the whole `[12,34,...]` contents of the file, not a path |
| `RPC_URL` | The RPC endpoint |

Note the overload: as an environment variable `KEEPER_KEYPAIR` is a path, but
as a secret it is the file's contents. The workflow writes the secret to a
`mktemp` file under `umask 077` and passes that path to the keeper, then
removes it in an `if: always()` step so a failed run cleans up too.

Neither value is printed. The keeper logs the endpoint as its origin only,
since a paid endpoint carries its key in the url, and both values are passed
through the environment rather than on a command line.

There is deliberately no `pull_request` trigger. A workflow that runs on
`pull_request` runs for forks, and a fork's branch is written by whoever opened
the pull request, so giving that secrets hands them over. The triggers are
`schedule` and `workflow_dispatch`, the latter being the **Run workflow**
button on the Actions tab.

A `concurrency` group named `keeper` stops two runs overlapping, with
`cancel-in-progress: false` so a late run queues rather than killing a keeper
between its `begin_execution` and its `settle_execution`.

**The IDL is committed for this.** The keeper needs `target/idl/paritas.json`,
which is gitignored, so a fresh CI checkout would not have one. `keeper/paritas-idl.json`
is a committed copy and the workflow points `PARITAS_IDL` at it. Regenerate it
with `npm run keeper:idl` whenever the program changes, or CI will run against
a stale IDL.

The keeper still needs SOL for fees and wrapper tokens to deliver, exactly as
on the droplet. Nothing about the schedule changes that.

## Deploying to the droplet

Superseded by the workflow above, kept for running the keeper as a long lived
process.


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
