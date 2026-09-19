# Paritas: verified facts. Do not invent values not in this file.

## Hard rule
Never invent a mint address, program ID, pubkey, or on-chain value.
If you need one that is not written here, STOP and ask.

## Build
Build with: cargo build-sbf --tools-version v1.57
NEVER use `anchor build`. It fails: bundled platform-tools v1.48 ships
rustc 1.84.1, which cannot parse dependencies requiring edition2024.
Deploy with: solana program deploy target/deploy/paritas.so
Cluster: devnet. anchor-lang 0.32.1, anchor-spl 0.32.1 (token_2022), edition 2021.
Paritas program ID: 5QkWw7s4dQwAhNZQoKGDTrb6xqcZnMi8XPA7tAkD29LV

## NVDAx (Backed / xStocks), read at mainnet slot 447023331
mint: Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh
token program: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb (Token-2022)
decimals: 8
scaledUiAmountConfig.multiplier: 1.0009180758490996
scaledUiAmountConfig.newMultiplier: 1.001701196801074
newMultiplierEffectiveTimestamp: 1789000200 (in the past, so newMultiplier is live)
extensions: metadataPointer, permanentDelegate, defaultAccountState(initialized),
scaledUiAmountConfig, pausableConfig, confidentialTransferMint,
transferHook(programId null), tokenMetadata

## NVDAon (Ondo Global Markets), read at mainnet slot 447023331
mint: gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo
token program: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb (Token-2022)
decimals: 9
scaledUiAmountConfig.multiplier: 1.0017152487959897
scaledUiAmountConfig.newMultiplier: 1.0017152487959897
newMultiplierEffectiveTimestamp: 1788998645 (past, no pending change)
extensions: scaledUiAmountConfig, metadataPointer, pausableConfig,
defaultAccountState(initialized), confidentialTransferMint,
transferHook(programId null), tokenMetadata
NOTE: no permanentDelegate on this mint, unlike NVDAx.

## SPYx (Backed / xStocks), read at mainnet slot 448337989
mint: XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W
token program: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb (Token-2022)
decimals: 8
scaledUiAmountConfig.multiplier: 1.003909240011759
scaledUiAmountConfig.newMultiplier: 1.005714560286254
newMultiplierEffectiveTimestamp: 1781755200 (in the past, so newMultiplier is live)
extensions: metadataPointer, permanentDelegate, defaultAccountState,
scaledUiAmountConfig, pausableConfig, confidentialTransferMint,
transferHook, tokenMetadata
NOTE: one wrapper only. There is no second SPY wrapper in this project.

## Pyth price feeds, verified 2026-09-19
Underlying equity feeds, not per wrapper feeds: a saver owns shares of the
underlying whichever wrapper the vault holds. Verified by symbol against
Hermes /v2/price_feeds (keyless), and on chain: the sponsored price account at
the push oracle PDA for shard 0 holds this same feed id.
Equity.US.NVDA/USD: b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593
Equity.US.SPY/USD: 19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5
schedule: America/New_York 0930-1600 weekdays, closed weekends and holidays.
Outside those hours the latest price is the last close.
NOT these, which share the naming pattern: Crypto.NVDAX/USD, Crypto.NVDAON/USD,
Crypto.SPYX/USD (per wrapper), Equity.Index.NVDA/USD (a 24/7 index price).
NOTE: since 2026-08-26 16:00 UTC Hermes price reads need an API key,
Authorization: Bearer, base https://pyth.dourolabs.app/hermes. The sponsored
on chain accounts for both feeds stopped updating at that time (mainnet last
publish 2026-08-26T15:54:46Z, devnet 2026-07-02), so they are not a live source.

## The thesis
Both tokens represent one share of NVIDIA. Their multipliers differ
(1.001701196801074 vs 1.0017152487959897), so one raw unit of NVDAon carries
about 0.140 basis points more economic value than one raw unit of NVDAx.
Decimals also differ (8 vs 9). Any swap treating them as 1:1 is wrong.

## Critical implementation detail
The multiplier is stored as an f64 in the mint account. Read it once, convert
immediately to u128 fixed-point, and do NO float arithmetic afterwards.
Solana's docs state the scaled-UI conversion helpers use floating point and
are not guaranteed to round-trip. All rate math must be integer fixed-point.

## Style
No em dashes or en dashes anywhere, in code, comments, or copy.

## USDC
mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  verified on-chain: owner TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
  (classic SPL Token, not Token-2022), 82 byte mint, no extensions.
devnet: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
  from faucet.circle.com

NOTE: USDC is classic SPL. The xStock and Ondo wrappers are Token-2022.
Every transaction touching both legs needs two distinct token programs.
Devnet has no real xStock or Ondo mints. The devnet demo needs mock
Token-2022 mints with a ScaledUiAmountConfig set to the real multiplier
values above, or a Surfpool mainnet fork.
