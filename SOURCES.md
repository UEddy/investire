# Sources

Every factual claim this project makes, with the value, where it came from,
and how to check it independently. Values here were read from CONTEXT.md, from
`devnet.json`, from the code, or from chain at the slot stated.

**Everything outside the Open questions section was checked directly against
chain state, issuer source code, or issuer documentation, and the command or
reference to repeat that check is given with it.** What could not be verified
to that standard was not guessed at: it is collected in section 7, Open
questions, so a reader knows exactly where the evidence stops.

Two corrections to claims that have been made about this project in the past
are recorded in place, under "Holder counts" and "Artwork reuse". They did not
survive checking.

## 1. On-chain state, mainnet

Read at the slots below. **Multipliers move**, which is why every row carries
the slot it was read at: a reader running the same command later will see the
same fields with possibly different values, and the numbers this project's
claims rest on are the ones at these slots.

### NVDAx (Backed, xStocks)

| Field | Value |
| --- | --- |
| mint | `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` |
| token program | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (Token-2022) |
| decimals | 8 |
| multiplier | 1.0009180758490996 |
| newMultiplier | 1.001701196801074 |
| newMultiplierEffectiveTimestamp | 1789000200 |
| mint authority | `7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj` |
| slot read at | 447023331 (CONTEXT.md), re-read unchanged at 448676749 |

### NVDAon (Ondo Global Markets)

| Field | Value |
| --- | --- |
| mint | `gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo` |
| token program | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (Token-2022) |
| decimals | 9 |
| multiplier | 1.0017152487959897 |
| newMultiplier | 1.0017152487959897 |
| newMultiplierEffectiveTimestamp | 1788998645 |
| mint authority | `9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD` |
| slot read at | 447023331 (CONTEXT.md), re-read unchanged at 448676754 |

### SPYx (Backed, xStocks)

| Field | Value |
| --- | --- |
| mint | `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W` |
| token program | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (Token-2022) |
| decimals | 8 |
| multiplier | 1.003909240011759 |
| newMultiplier | 1.005714560286254 |
| newMultiplierEffectiveTimestamp | 1781755200 |
| mint authority | `7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj` |
| slot read at | 448337989 (CONTEXT.md), re-read unchanged at 448676757 |

Both xStocks share one mint authority; the Ondo mint's authority is a
different address, and is off curve, consistent with a program derived
address rather than a keypair.

### Check any of them now

Replace the mint address to switch rows. The response carries the slot it was
answered at in `result.context.slot`.

```bash
curl -s https://api.mainnet-beta.solana.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":
      ["Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
       {"encoding":"jsonParsed","commitment":"finalized"}]}' \
| python3 -c 'import json,sys
r=json.load(sys.stdin)["result"]
i=r["value"]["data"]["parsed"]["info"]
c=[e for e in i["extensions"] if e["extension"]=="scaledUiAmountConfig"][0]["state"]
print("slot", r["context"]["slot"])
print("decimals", i["decimals"], "mintAuthority", i.get("mintAuthority"))
print(c["multiplier"], c["newMultiplier"], c["newMultiplierEffectiveTimestamp"])'
```

To check that a mint authority is off curve, and so cannot be a keypair:

```bash
# from app/, where @solana/web3.js is installed
node -e 'const {PublicKey}=require("@solana/web3.js");
console.log(PublicKey.isOnCurve(new PublicKey(process.argv[1]).toBytes()))' \
  9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD    # false
```

## 2. The claims that rest on that state

All arithmetic below uses the values in section 1. The live multiplier of a
mint is `newMultiplier` when `newMultiplierEffectiveTimestamp` has passed,
otherwise `multiplier`; that rule is the program's, in
`programs/paritas/src/multiplier.rs`, `current_multiplier_fixed`.

### Cross wrapper drift, NVDAx against NVDAon

Both are live on their `newMultiplier` (both timestamps are in the past).

```
NVDAx live multiplier   1.001701196801074
NVDAon live multiplier  1.0017152487959897

(1.0017152487959897 - 1.001701196801074) / 1.001701196801074
  = 1.4029e-05
  = 0.001403 percent
  = 0.1403 basis points
```

**The correct unit is 0.140 basis points, not 1.40.** One basis point is
0.01 percent, so 0.001403 percent is 0.140 basis points. Stated plainly: one
NVDAon token carries about 0.0014 percent more of a share than one NVDAx
token, once their differing decimals are accounted for.

Reproduce:

```bash
node -e 'const x=1.001701196801074,o=1.0017152487959897;
console.log("percent", ((o-x)/x*100).toPrecision(4));
console.log("basis points", ((o-x)/x*10000).toFixed(4))'
```

### Accumulated multiplier since launch

The multiplier starts at 1.0 when a mint is created and is moved by the issuer
for corporate actions, so `live multiplier - 1` is everything accrued since
launch. This assumes the mint was created at exactly 1.0, which is not
something we established; see Open questions, "Whether a mint starts at
exactly 1.0".

| Token | Live multiplier | Accumulated since launch |
| --- | --- | --- |
| NVDAx | 1.001701196801074 | 0.1701 percent, 17.01 basis points |
| NVDAon | 1.0017152487959897 | 0.1715 percent, 17.15 basis points |
| SPYx | 1.005714560286254 | 0.5715 percent, 57.15 basis points |

```bash
node -e 'for (const [k,v] of Object.entries({NVDAx:1.001701196801074,
  NVDAon:1.0017152487959897, SPYx:1.005714560286254}))
  console.log(k, ((v-1)*100).toFixed(4)+" percent", ((v-1)*10000).toFixed(2)+" bps")'
```

### The SPYx stale field finding

SPYx is the clearest case of why a reader must not take the field named
`multiplier` at face value. Its `newMultiplierEffectiveTimestamp` is
1781755200, which is 2026-06-18T04:00:00Z, in the past, so the effective
multiplier has been 1.005714560286254 since June 2026. The field literally
named `multiplier` still reads 1.003909240011759.

```
effective (newMultiplier)  1.005714560286254
field named multiplier     1.003909240011759

(1.005714560286254 - 1.003909240011759) / 1.003909240011759
  = 1.7983e-03
  = 0.1798 percent
  = 17.98 basis points, about 18
```

Anything valuing SPYx from the field named `multiplier` is roughly 18 basis
points low, indefinitely, and nothing on the mint flags it.

```bash
node -e 'const s=1.003909240011759,n=1.005714560286254;
console.log(((n-s)/s*10000).toFixed(2), "basis points");
console.log(new Date(1781755200*1000).toISOString())'
```

**Holder counts.** SPYx has been described in this project as the xStock with
the largest holder count. That is not what the data shows. Measured through
Jupiter's token search on 2026-09-20, NVDAx has 95,071 holders and SPYx has
73,337, the two largest of the 14 xStocks sampled (QQQx 37,856, TSLAx 38,707,
AAPLx 32,659, GLDx 29,715, GOOGLx 28,260, MSFTx 24,762, CRCLx 19,731, AMZNx
14,619, METAx 14,103, MSTRx 13,276, COINx 8,750, TQQQx 719, AMBRx 574). SPYx
is second among those sampled. The full xStocks list was not enumerated, so
"second largest" is claimed only across this sample. Holder counts drift by
the minute: SPYx read 73,337 and then 73,332 a few minutes later on the same
day, so treat every figure here as a snapshot of 2026-09-20, not a constant.

```bash
curl -s "https://lite-api.jup.ag/tokens/v2/search?query=SPYx" \
| python3 -c 'import json,sys
for t in json.load(sys.stdin):
  if t.get("isVerified"): print(t["symbol"], t["holderCount"], t["id"])'
```

## 3. Provenance of every address

The point of this section is that each address is established as genuine, not
merely plausible.

### Paritas program, devnet

`5QkWw7s4dQwAhNZQoKGDTrb6xqcZnMi8XPA7tAkD29LV`, from `devnet.json` and
`programs/paritas/src/lib.rs` (`declare_id!`). It is ours; the keypair is in
`target/deploy/paritas-keypair.json` and is not committed.

```bash
solana program show 5QkWw7s4dQwAhNZQoKGDTrb6xqcZnMi8XPA7tAkD29LV --url devnet
```

### NVDAon, and the Ondo Global Markets program

`XzTT4XB8m7sLD2xi6snefSasaswsKCxx5Tifjondogm` is the Ondo Global Markets
program on mainnet. Established three ways, not one:

1. **Published in Ondo's own open source repository, under the mainnet
   feature flag.** `programs/ondo-gm/src/lib.rs` lines 21 and 22 of
   [ondoprotocol/global-markets-solana](https://github.com/ondoprotocol/global-markets-solana):

   ```rust
   #[cfg(feature = "mainnet")]
   declare_id!("XzTT4XB8m7sLD2xi6snefSasaswsKCxx5Tifjondogm");
   ```

   The same file declares different ids for devnet (line 18) and testnet
   (line 20), so the mainnet flag is what picks this one.

2. **It exists on chain and is an executable program**, owned by the
   upgradeable BPF loader.

3. **Observed in a live transaction touching the NVDAon mint.** Signature
   `585bJ3r9fKiCfC881ZG5LVLywuww9hcYHNkjWEgH4WA3gpUhHai5GmqqovfpdQw9XQuhCaGGmdz86kUs8G5baH8m`,
   slot 448668010, 2026-09-20T07:46:06Z. The Ondo program is a top level
   program of that transaction; its logged instructions are RedeemForUsdc,
   MintTo, TransferChecked and BurnChecked, and the post balances include the
   NVDAon mint `gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo`.

```bash
curl -s https://api.mainnet-beta.solana.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":
      ["XzTT4XB8m7sLD2xi6snefSasaswsKCxx5Tifjondogm",{"encoding":"base64"}]}' \
| python3 -c 'import json,sys; v=json.load(sys.stdin)["result"]["value"];
print("executable", v["executable"], "owner", v["owner"])'
```

The transaction can be opened at
`https://explorer.solana.com/tx/585bJ3r9fKiCfC881ZG5LVLywuww9hcYHNkjWEgH4WA3gpUhHai5GmqqovfpdQw9XQuhCaGGmdz86kUs8G5baH8m`.

What is established here is that the authority is off curve and that the Ondo
program appears as a top level program in a transaction that moves this mint.
Deriving the authority from the program's own seeds would tie the two together
directly; see Open questions, "Deriving NVDAon's mint authority".

### Why symbol resolution is never used

A Jupiter token search for NVDAX on 2026-09-20 returned **20 results, of
which one is the genuine token** (`Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh`,
verified, 95,071 holders) **and 19 are impersonators**, all unverified and
nearly all with a single holder. Several copy the genuine token's name
exactly: three of the nineteen are named "NVIDIA xStock".

**Artwork reuse.** This project has previously claimed that several
impersonators reuse the real token's artwork. Checked by comparing icon URLs,
that is not supported: the genuine token's icon is
`https://xstocks-metadata.backed.fi/logos/tokens/NVDAx.png` and **no**
impersonator in the result set points at that URL. Whether any of them host a
visually identical copy elsewhere was not checked; see Open questions,
"Whether impersonators copy the artwork".

```bash
curl -s "https://lite-api.jup.ag/tokens/v2/search?query=NVDAX" \
| python3 -c 'import json,sys
a=json.load(sys.stdin); print("results", len(a))
for t in a: print(t["id"], t["symbol"], repr(t.get("name")), "verified", t.get("isVerified"), "holders", t.get("holderCount"))'
```

This is why `register_pair` and `add_wrapper` are explicit on chain
allowlists keyed by mint address, and why nothing in the program or the app
resolves an asset by symbol. See `programs/paritas/src/state.rs`, the `Pair`
and `Wrapper` doc comments.

### Devnet addresses

Every devnet address is generated by `scripts/setup-devnet.ts` and recorded in
`devnet.json`; none is written by hand anywhere in the code. Current contents,
generated 2026-09-19T08:22:43Z:

| What | Address |
| --- | --- |
| Payment mint (devnet USDC, from faucet.circle.com) | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| NVDA vault | `8mnLotdw9eXnciucKw6puzJALPSHBz9kE32bdqpv9oML` |
| NVDA receipt mint | `746EnykjM8jtT1ZxQTd8HsbMfbkLEYuyaM54RXrL4ojQ` |
| SPY vault | `9mnzLKHjF7zgWNVEFucKPh144LFABAYVnPgcpfDfjRYa` |
| SPY receipt mint | `9mrQ7JHVydnBKaJNfDmC1QWBrjBeHeM7wg3nXugkHULH` |
| Mock NVDAx | `FWk32ZCua2ZKQoMhdDzH6hos3iNuuUwjKf9Xou4rQQHo` |
| Mock NVDAon | `EwFZ8cTZ8AUDQL9eJ3JWoh2py53WVewQtxAmopZhQua7` |
| Mock SPYx | `AjeMGrf7sVt6uQAHFhBVKMphJ8b99TwMjMqVjqDqyYdE` |
| Cash out liquidity key (devnet only) | `3VKdmb4yHUdhz1L2DfcfrEqjPo8qFXdrK1xwqonJ7KSu` |

Keeper fee on both vaults: 25 basis points of the buy, minimum 0.05 USDC,
capped by the program at `MAX_KEEPER_FEE_BPS` of 200.

## 4. Issuer documentation relied on

### xStocks multiplier timing

The xStocks developer documentation states: "The activation time of the
multiplier is set for 00:30 UTC the day immediately following the 'Ex date'
(when dividends are excluded from future holders)."
Source: <https://docs.xstocks.fi/developers/multipliers>, and the same timing
at <https://docs.xstocks.fi/docs/dividends-and-stock-splits>.

**Chain state agrees with the documentation.** NVDAx's
`newMultiplierEffectiveTimestamp` is 1789000200, which decodes to
2026-09-10T00:30:00Z: exactly 00:30 UTC, on the day following an ex-date of
2026-09-09. In New York terms that instant is 20:30 on 2026-09-09, the day
before, which is where the informal "about 8pm ET the day before" comes from.

```bash
node -e 'console.log(new Date(1789000200*1000).toISOString(),
  new Date(1789000200*1000).toLocaleString("en-US",
    {timeZone:"America/New_York", timeZoneName:"short"}))'
# 2026-09-10T00:30:00.000Z 9/9/2026, 8:30:00 PM EDT
```

Note the time zone precisely: 00:30 UTC is 20:30 EDT while New York is on
summer time, and 19:30 EST otherwise, so "8:00 PM EST" is a loose restatement.
The phrase "8:00 PM EST" does not appear in either page cited above; what they
state is 00:30 UTC. Where that phrasing comes from, and whether SPYx's own
timestamp follows the documented rule at all, are both unsettled: see Open
questions, "The SPYx activation timestamp" and "The 8:00 PM EST phrasing".

### Ondo Global Markets program

Repository: <https://github.com/ondoprotocol/global-markets-solana>, licensed
**BUSL-1.1**. It was **read as reference only. No code was copied** into this
project. File and line references, at the repository HEAD when read on
2026-09-20:

| What | Where |
| --- | --- |
| Mainnet program id under the mainnet feature flag | `programs/ondo-gm/src/lib.rs:21-22` |
| `ExtensionType::ScaledUiAmount` in the mint's extension list | `programs/ondo-gm/src/instructions/token_factory.rs:66` |
| ScaledUiAmount initialised on the new mint | `token_factory.rs:115-122` |
| `AccountState::Initialized` as the default account state | `token_factory.rs:155-162`, the constant itself at line 159 |
| TransferHook initialised with **no hook program** (`None`) | `token_factory.rs:181-187` |
| `verify_whitelist` | `programs/ondo-gm/src/instructions/token_manager.rs:879` |
| `verify_attestation` | `token_manager.rs:194` |
| `mint_with_attestation`, calling both | `token_manager.rs:928`, whitelist at 955, attestation at 985 |
| `redeem_with_attestation`, calling both | `token_manager.rs:1087`, whitelist at 1114, attestation at 1145 |

**Whitelist and attestation are scoped to mint and redeem, not to transfer.**
The only call sites of `verify_whitelist` in the program are inside
`mint_with_attestation` and `redeem_with_attestation`; there is no third. The
mint is created with the TransferHook extension present but initialised with
`None` as the hook program, so no program runs on transfer. This agrees with
chain state: the live NVDAon mint reports `transferHook` with a null program
id. The practical consequence for us is that a vault can hold and move NVDAon
without being whitelisted; only minting and redeeming with Ondo require it.

```bash
curl -s "https://raw.githubusercontent.com/ondoprotocol/global-markets-solana/HEAD/programs/ondo-gm/src/instructions/token_manager.rs" \
  | grep -n "verify_whitelist"      # 879 definition, 955 and 1114 the only calls
```

## 5. Pyth feeds

Both feeds are for the **underlying equity**, never for a wrapper: a saver
owns a share of NVIDIA whichever token carried it.

| Feed | Id |
| --- | --- |
| `Equity.US.NVDA/USD` | `b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593` |
| `Equity.US.SPY/USD` | `19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5` |

**Verified against the published feed list, not inferred from the naming
pattern.** The ids were matched by exact symbol in Hermes' feed catalogue,
which needs no API key, and `scripts/setup-devnet.ts` re-checks them on every
run (`verifyPriceFeed`): it fetches the catalogue, finds the entry whose
`attributes.symbol` equals the symbol recorded in CONTEXT.md, and fails the
setup if the id differs.

```bash
curl -s "https://hermes.pyth.network/v2/price_feeds?query=NVDA&asset_type=equity" \
| python3 -c 'import json,sys
for f in json.load(sys.stdin): print(f["id"], f["attributes"]["symbol"])'
```

Each id also appears inside Pyth's own on chain price account for that feed,
at the push oracle PDA for shard 0 under program
`pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT`: `2w1Tg1XTZbUib7srfRoStJ4v5JXVsK7roQEGMsMaGZFC`
for NVDA and `9owhtgrdLiUMAH9JKxYFt5pUY4Luy4EzzLhdcWPVuDyy` for SPY.

**Lookalikes deliberately not used**, all of which a naming pattern would have
matched:

| Feed | Why not |
| --- | --- |
| `Crypto.NVDAX/USD` | Prices the xStocks wrapper, not the underlying |
| `Crypto.NVDAON/USD` | Prices the Ondo wrapper, not the underlying |
| `Crypto.SPYX/USD` | Prices the xStocks wrapper, not the underlying |
| `Crypto.NVDAX/NVDA.RR` | A redemption rate, not a price |
| `Crypto.SPYX/SPY.RR` | A redemption rate, not a price |
| `Equity.Index.NVDA/USD` | A 24/7 index price ("PYTH PRICE IN USD FOR NVDA 24/7"), not the regular session equity feed |
| `Equity.US.SPYG/USD`, `Equity.US.SPYV/USD`, `Equity.US.SPYM/USD` | Different funds that a SPY prefix search returns |

Both equity feeds carry the regular US session schedule, weekdays 09:30 to
16:00 America/New_York with holidays listed, which is why the keeper skips a
stale price rather than trading on one.

**Status: the project's Hermes API key is not yet accepted.** Since
2026-08-26 16:00 UTC, Hermes requires a key for price reads, and the sponsored
on chain accounts above stopped updating at the same time (mainnet last
publish 2026-08-26T15:54:46Z). The key set in production returns 403, so live
valuation is integrated and awaiting key activation; see the status note in
`app/README.md`.

## 6. Toolchain

| What | Version | Where pinned |
| --- | --- | --- |
| Rust | 1.89.0 | `rust-toolchain.toml` |
| Solana platform tools | v1.57 | build command below, from CONTEXT.md |
| anchor-lang, anchor-spl | 0.32.1, `token_2022` feature | `programs/paritas/Cargo.toml` |
| Rust edition | 2021 | `programs/paritas/Cargo.toml` |
| anchor-cli | 0.32.1 | installed toolchain, `anchor --version` |
| solana-cli | 2.3.0 (Agave, src a2e21dda) | installed toolchain, `solana --version` |
| Node | v24.10.0 | installed toolchain, `node --version` |
| Next.js | ^15.1.0 | `app/package.json` |
| @coral-xyz/anchor (TS) | ^0.32.1 | `app/package.json` |
| @solana/web3.js | ^1.98.0 | `app/package.json` |
| @solana/spl-token | ^0.4.15 | `app/package.json` |

Build, deploy and IDL:

```bash
cargo build-sbf --tools-version v1.57          # from programs/paritas
solana program deploy target/deploy/paritas.so
anchor idl build -p paritas -o target/idl/paritas.json
```

**Why `anchor build` is not used.** CONTEXT.md, lines 8 to 11: the bundled
platform tools v1.48 ship rustc 1.84.1, which cannot parse dependencies
requiring edition2024, so `anchor build` fails. `cargo build-sbf` with
`--tools-version v1.57` uses a toolchain new enough to parse them.
`anchor idl build` is unaffected, because it compiles on the host toolchain
rather than the SBF one.

## 7. Open questions

These are the claims this project could not verify to the standard of the rest
of this document. Each one says what was being established, how far the
evidence actually goes, and what would settle it, so that a reader can pick one
up and finish it. None of them is resolved by guessing, and nothing elsewhere
in this file rests on one being true.

### The SPYx activation timestamp

**What we tried to establish.** That the xStocks multiplier activation rule in
Backed's documentation describes the behaviour of every xStock mint, so that
the timestamp on a mint can be read as confirming the documented process.

**How far we got.** For NVDAx it holds exactly. Backed's documentation states
that "the activation time of the multiplier is set for 00:30 UTC the day
immediately following the 'Ex date'", and NVDAx's
`newMultiplierEffectiveTimestamp` of 1789000200 decodes to
2026-09-10T00:30:00Z: 00:30 UTC to the second, consistent with an ex-date of
2026-09-09. For SPYx it does not. Its timestamp 1781755200 decodes to
2026-06-18T04:00:00Z, which is 00:00 on 2026-06-18 in New York, midnight EDT,
not 00:30 UTC. The difference is not a rounding artifact or a time zone
misreading: 00:30 UTC and 04:00 UTC are three and a half hours apart, and the
two mints are run by the same issuer under the same mint authority
`7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj`.

**What this means, plainly.** Either the documented rule does not apply
uniformly across xStocks, or the timing changed at some point between these two
mints last being updated. We cannot tell which from two data points, and the
documentation gives one rule with no exceptions and no version history. Both
readings matter for anyone building on this: the first means the activation
time is per asset and cannot be assumed, the second means the documentation
describes current practice only and historical timestamps have to be read in
the light of whatever rule was in force at the time.

**What would settle it.** Read the multiplier history of several more xStocks,
not two, and compare each activation timestamp against that asset's ex-date.
The comparison is what identifies the pattern: a set of mints that all activate
at 00:30 UTC the day after their ex-date, with SPYx alone at 04:00 UTC, points
to a per asset exception; a clean split by date, older updates at 04:00 UTC and
newer ones at 00:30 UTC, points to a change in practice. The mint list is on
the issuer's site, activation timestamps come from the same
`getAccountInfo` command used in section 1, historical values need the mint's
transaction history or an archival RPC that serves past slots, and ex-dates
come from any corporate actions source for the underlying. A dozen mints would
be enough to tell the two explanations apart; if the split is by date, the
changeover date itself is the answer.

### The 8:00 PM EST phrasing

**What we tried to establish.** A primary source for the claim, repeated in
this project's own notes, that xStocks update the multiplier at approximately
8:00 PM EST on the day before the ex-date.

**How far we got.** The phrase does not appear on either Backed documentation
page we read, <https://docs.xstocks.fi/developers/multipliers> or
<https://docs.xstocks.fi/docs/dividends-and-stock-splits>. Both state 00:30
UTC on the day following the ex-date. The two are the same instant while New
York is on summer time, when 00:30 UTC is 20:30 the previous evening, so the
phrasing is a defensible restatement for part of the year and wrong by an hour
for the rest of it. It surfaced in a search summary attributed to xStocks
material we did not locate.

**What would settle it.** Find the page that uses that wording, or establish
that none does. Candidates are the Kraken xStocks FAQ, Backed's own blog and
any PDF product documentation, all of which are outside the two developer
pages we checked. If no primary source uses it, the phrasing should be dropped
from this project's materials in favour of the documented 00:30 UTC, which is
what chain state matches.

### Whether a mint starts at exactly 1.0

**What we tried to establish.** That `live multiplier - 1` is the whole of what
a wrapper has accumulated since launch, which is how section 2 presents it.

**How far we got.** The arithmetic is right if and only if the mint's
multiplier was exactly 1.0 when it was created. That is the natural default for
a scaled UI amount mint and no issuer document we read contradicts it, but we
did not verify it for any of the three mints. Everything in the accumulated
multiplier table is therefore accurate as "distance from 1.0" and only
provisional as "accumulated since launch".

**What would settle it.** Read the mint's first `InitializeScaledUiAmountConfig`
instruction from its transaction history, which carries the initial multiplier
as an argument. That needs an archival RPC able to serve the mint's earliest
signatures, since the public endpoints page back only so far. Failing that, an
issuer statement of the launch value for each mint.

### Deriving NVDAon's mint authority

**What we tried to establish.** That the NVDAon mint is under the control of
the Ondo Global Markets program at
`XzTT4XB8m7sLD2xi6snefSasaswsKCxx5Tifjondogm`, rather than of a keypair someone
holds.

**How far we got.** Three pieces of evidence, none of them a derivation: the
mint authority `9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD` is off curve, so
it cannot be an ordinary keypair; the account does not exist on chain, which is
what a program derived address that has never been funded looks like; and the
Ondo program is a top level program in a live transaction that moves this mint
(signature `585bJ3r9...baH8m`, section 3). That is strong circumstantial
evidence and not proof.

**What would settle it.** Derive the address. The program's source is public,
so the seeds are readable: `programs/ondo-gm/src/constants.rs:33` defines
`MINT_AUTHORITY_SEED` as `b"mint_authority"`, and
`programs/ondo-gm/src/instructions/token_factory.rs:61` signs with it. Recompute
`PublicKey.findProgramAddressSync` with that seed against the mainnet program
id and check the result equals `9foMHs...`. If the seeds include a per token
discriminator, the token's own parameters are needed as well, which the factory
instruction's accounts show.

### Whether impersonators copy the artwork

**What we tried to establish.** That several of the nineteen NVDAX
impersonators reuse the genuine token's artwork, which would make the case
against symbol resolution stronger than name reuse alone.

**How far we got.** Disproved for the narrow reading. No impersonator in the
Jupiter result set points at the genuine icon URL,
`https://xstocks-metadata.backed.fi/logos/tokens/NVDAx.png`. What is
established is name reuse: three of the nineteen carry the name "NVIDIA
xStock" exactly. The broader claim, that an impersonator hosts a visually
identical copy of the image at its own URL, was not tested at all.

**What would settle it.** Fetch each impersonator's icon and compare it to the
genuine image, by hash for an exact copy and by a perceptual hash for a resized
or recompressed one. The URLs are in the same Jupiter search result used in
section 3. Either the claim is then evidenced and can be made, or it should be
dropped in favour of the name reuse finding, which is already documented.

## 8. What is substituted on devnet, and what replaces it on mainnet

Devnet has no real xStocks or Ondo mints and no Jupiter deployment, so four
things stand in. Each is marked in the code where it is used.

### Mock wrapper mints

**Stands in for:** the real NVDAx, NVDAon and SPYx mints.
**What they are:** Token-2022 mints created by `scripts/setup-devnet.ts`,
initialised at the live multiplier of the mint they stand for, taken from
CONTEXT.md. After creation the script reads each mock back and fails if the
fixed point multiplier the program would compute differs from the real
mint's, so a mock cannot silently drift (`ensureMockMint`,
`scripts/setup-devnet.ts:233`, comparison at line 323).
**What is preserved:** the decimals, and the multiplier difference between
NVDAx and NVDAon that the whole thesis rests on.
**What is not:** a pending multiplier change with a past effective timestamp
cannot be recreated, because Token-2022 collapses both fields in that case.
The mocks are therefore initialised directly at the live value.
**On mainnet:** point the address book at the real mints. Nothing in the
program changes.

### The buy swap leg

**Stands in for:** a Jupiter route that sells the buy's USDC and delivers the
wrapper into the execution escrow.
**What it is:** a plain transfer from the keeper's own wrapper inventory into
the escrow, sized at the quoted price. Marked in `keeper/index.ts:647` under a
DEVNET SUBSTITUTE banner.
**Why the program does not care:** `settle_execution` measures the escrow's
balance, values it at the live multiplier and checks it against the schedule's
floor. It would do that whatever delivered the tokens.
**On mainnet:** that one instruction becomes the Jupiter route with the escrow
as its destination. Nothing else changes.

### The cash out sale leg

**Stands in for:** a Jupiter route that sells the wrapper `begin_cash_out`
paid out and delivers USDC into the cash out escrow.
**What it is:** two plain transfers, the saver's wrapper to a devnet liquidity
key and that key's USDC into the escrow. Marked in
`app/src/lib/paritas.ts:1214` under the same banner.
**The co-signing key:** because the liquidity key moves its own USDC it must
sign, which is the one thing a real route does not need. `/api/cash-out`
builds the transaction and signs only that key's part
(`app/src/app/api/cash-out/route.ts:192`); the saver signs and sends it, so it
is still one transaction and one wallet prompt. The key is
`3VKdmb4yHUdhz1L2DfcfrEqjPo8qFXdrK1xwqonJ7KSu`, devnet only, and the route
refuses to co-sign with any key that is not the one `devnet.json` names.
**On mainnet:** the two transfers become one Jupiter route signed by the saver
alone, and the route and its key disappear.

### The price quote

**Stands in for:** a Jupiter quote on the buy side, and a market price on the
cash out side.
**What it is:** a flat 5.00 USDC per share, the default of
`KEEPER_QUOTE_USDC_PER_SHARE` and `CASH_OUT_QUOTE_USDC_PER_SHARE`. Both sides
use the same figure so devnet stays internally consistent.
**Why flat today:** Pyth pricing is built and switched by
`KEEPER_PRICE_SOURCE=pyth` (`keeper/index.ts:112`) and
`CASH_OUT_PRICE_SOURCE=pyth` (`app/src/app/api/cash-out/route.ts:104`), but
the Hermes key returns 403, so both default to flat.
**On mainnet:** the buy price is whatever the Jupiter route fills at, and the
cash out price likewise; the Pyth feed remains the valuation source for the
dashboard.
