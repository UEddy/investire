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
