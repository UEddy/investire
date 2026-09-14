# Paritas

**One share of NVIDIA is worth 1.40 basis points more depending on who wrapped it.**

NVDAx and NVDAon both represent a single NVIDIA share on Solana. Both reinvest
dividends by adjusting a multiplier stored in their Token-2022 mint account.
Those multipliers have drifted apart, because Backed and Ondo apply different
tax withholding and reinvest at different prices.

Neither token's holder can redeem. Ondo gates issuance behind a whitelist and a
signed attestation. Backed requires eligible direct client status and a $5,000
minimum. So the only route from one wrapper to the other is a round trip
through USDC on two venues, priced as though the two tokens are identical.

They are not identical, and the number that says so is already on-chain. No app
reads it.

Paritas reads both multipliers directly from mint state and swaps at the true
equity-unit rate. No oracle. No price feed. No keeper. The fair rate is
derivable from the two mint accounts alone.
