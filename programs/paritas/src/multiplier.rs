use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::scaled_ui_amount::ScaledUiAmountConfig;
use anchor_spl::token_2022::spl_token_2022::extension::{BaseStateWithExtensions, StateWithExtensions};
use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;

use crate::error::ParitasError;

/// Fixed point scale used to store a multiplier read from a mint. Chosen to
/// preserve the significant digits an f64 can actually carry (about 15 to 17
/// decimal digits), with headroom to spare.
pub const MULTIPLIER_SCALE: u128 = 1_000_000_000_000_000_000; // 1e18

/// Fixed point scale of the rate value returned by get_rate and consumed by
/// swap: amount_b = amount_a * rate / RATE_SCALE.
pub const RATE_SCALE: u128 = 1_000_000_000; // 1e9

/// Decimal precision at which an equity unit is expressed. An equity unit is
/// a raw wrapper amount scaled by that wrapper's effective multiplier and
/// normalised for decimals, so 10^EQUITY_UNIT_DECIMALS equity units is one
/// unit-share of the underlying, whichever wrapper it arrived as.
pub const EQUITY_UNIT_DECIMALS: u8 = 9;

/// Parses a Token-2022 mint account's raw data and returns its
/// ScaledUiAmountConfig extension. Errors if the data cannot be parsed as a
/// mint, or if the extension is not present, rather than guessing a rate.
pub fn read_scaled_ui_config(mint_data: &[u8]) -> Result<ScaledUiAmountConfig> {
    let state = StateWithExtensions::<Token2022Mint>::unpack(mint_data)
        .map_err(|_| error!(ParitasError::InvalidMintData))?;
    let config = state
        .get_extension::<ScaledUiAmountConfig>()
        .map_err(|_| error!(ParitasError::MissingScaledUiAmountExtension))?;
    Ok(*config)
}

/// Selects multiplier or new_multiplier by comparing new_multiplier_effective
/// _timestamp against `now`, then converts the chosen f64 straight to fixed
/// point. This is the only place float arithmetic happens; every computation
/// after this point is pure integer math on the returned value.
pub fn current_multiplier_fixed(config: &ScaledUiAmountConfig, now: i64) -> Result<u128> {
    let effective_ts: i64 = config.new_multiplier_effective_timestamp.into();
    let multiplier: f64 = if now >= effective_ts {
        config.new_multiplier.into()
    } else {
        config.multiplier.into()
    };

    if !multiplier.is_finite() || multiplier <= 0.0 {
        return err!(ParitasError::InvalidMultiplier);
    }

    let fixed = multiplier * MULTIPLIER_SCALE as f64;
    if !fixed.is_finite() || fixed < 0.0 || fixed > u128::MAX as f64 {
        return err!(ParitasError::InvalidMultiplier);
    }

    Ok(fixed.round() as u128)
}

/// Computes the fixed point exchange rate from token A to token B:
/// amount_b = amount_a * rate / RATE_SCALE
///
/// Normalises for differing decimals between the two mints. Uses only
/// checked integer arithmetic, so a pathological input errors out instead of
/// silently wrapping or truncating into a wrong rate.
pub fn compute_rate(
    mult_a_fixed: u128,
    decimals_a: u8,
    mult_b_fixed: u128,
    decimals_b: u8,
) -> Result<u128> {
    if mult_a_fixed == 0 || mult_b_fixed == 0 {
        return err!(ParitasError::InvalidMultiplier);
    }

    let numerator = mult_a_fixed
        .checked_mul(RATE_SCALE)
        .ok_or_else(|| error!(ParitasError::MathOverflow))?;

    let (numerator, denominator) = if decimals_b >= decimals_a {
        let diff = u32::from(decimals_b - decimals_a);
        let scale = 10u128
            .checked_pow(diff)
            .ok_or_else(|| error!(ParitasError::MathOverflow))?;
        let numerator = numerator
            .checked_mul(scale)
            .ok_or_else(|| error!(ParitasError::MathOverflow))?;
        (numerator, mult_b_fixed)
    } else {
        let diff = u32::from(decimals_a - decimals_b);
        let scale = 10u128
            .checked_pow(diff)
            .ok_or_else(|| error!(ParitasError::MathOverflow))?;
        let denominator = mult_b_fixed
            .checked_mul(scale)
            .ok_or_else(|| error!(ParitasError::MathOverflow))?;
        (numerator, denominator)
    };

    let rate = numerator
        .checked_div(denominator)
        .ok_or_else(|| error!(ParitasError::MathOverflow))?;

    // A rate that truncated to zero would make every conversion built on it
    // return nothing at all, silently. Reachable when the decimals gap
    // between the two mints is wide enough to sink the numerator below the
    // denominator, so it is an error rather than a usable rate.
    if rate == 0 {
        return err!(ParitasError::InvalidMultiplier);
    }

    Ok(rate)
}

/// Converts a raw amount of a wrapper into equity units.
///
/// This is compute_rate with an identity mint on the output side: a virtual
/// mint whose multiplier is exactly 1.0 (MULTIPLIER_SCALE is the fixed point
/// representation of 1.0) and whose decimals are EQUITY_UNIT_DECIMALS. That
/// is precisely the definition of an equity unit, so no separate math is
/// needed: raw amount scaled by the wrapper's effective multiplier and
/// normalised for decimals, with no scaling of its own left to undo.
///
/// Truncates down, favouring the vault.
pub fn to_equity_units(amount_in: u64, decimals: u8, mult_fixed: u128) -> Result<u64> {
    let rate = compute_rate(mult_fixed, decimals, MULTIPLIER_SCALE, EQUITY_UNIT_DECIMALS)?;
    convert_amount(amount_in, rate)
}

/// Converts equity units back into a raw amount of a specific wrapper, at
/// that wrapper's own effective multiplier. The exact inverse of
/// to_equity_units, with the identity mint on the input side instead.
///
/// Because both directions route through the same equity unit intermediate,
/// depositing one wrapper and withdrawing a different one preserves the
/// holder's economic quantity of the underlying: each wrapper's multiplier
/// is applied on its own leg, so the drift between two wrappers of the same
/// equity is carried through rather than assumed away.
///
/// Truncates down, favouring the vault.
pub fn from_equity_units(equity_units: u64, decimals: u8, mult_fixed: u128) -> Result<u64> {
    let rate = compute_rate(MULTIPLIER_SCALE, EQUITY_UNIT_DECIMALS, mult_fixed, decimals)?;
    convert_amount(equity_units, rate)
}

/// Converts an input amount of token A into an output amount of token B using
/// a rate from compute_rate. Truncates down, so the pool never pays out more
/// than the rate allows.
pub fn convert_amount(amount_in: u64, rate: u128) -> Result<u64> {
    let amount_out = (amount_in as u128)
        .checked_mul(rate)
        .ok_or_else(|| error!(ParitasError::MathOverflow))?
        .checked_div(RATE_SCALE)
        .ok_or_else(|| error!(ParitasError::MathOverflow))?;

    u64::try_from(amount_out).map_err(|_| error!(ParitasError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_spl::token_2022::spl_token_2022::extension::{
        BaseStateWithExtensionsMut, ExtensionType, StateWithExtensionsMut,
    };
    use anchor_spl::token_2022::spl_token_2022::extension::scaled_ui_amount::{PodF64, UnixTimestamp};

    // Fixtures from CONTEXT.md, read at mainnet slot 447023331.
    const NVDAX_DECIMALS: u8 = 8;
    const NVDAX_MULTIPLIER: f64 = 1.0009180758490996;
    const NVDAX_NEW_MULTIPLIER: f64 = 1.001701196801074;
    const NVDAX_EFFECTIVE_TS: i64 = 1789000200;

    const NVDAON_DECIMALS: u8 = 9;
    const NVDAON_MULTIPLIER: f64 = 1.0017152487959897;
    const NVDAON_NEW_MULTIPLIER: f64 = 1.0017152487959897;
    const NVDAON_EFFECTIVE_TS: i64 = 1788998645;

    /// A timestamp after both mints' effective timestamps, matching
    /// CONTEXT.md's description of both new_multiplier values as live.
    const NOW_AFTER_BOTH: i64 = 1_800_000_000;

    fn build_mint_with_scaled_ui(
        decimals: u8,
        multiplier: f64,
        new_multiplier: f64,
        effective_timestamp: i64,
    ) -> Vec<u8> {
        let space =
            ExtensionType::try_calculate_account_len::<Token2022Mint>(&[ExtensionType::ScaledUiAmount])
                .unwrap();
        let mut buffer = vec![0u8; space];

        let mut state = StateWithExtensionsMut::<Token2022Mint>::unpack_uninitialized(&mut buffer)
            .unwrap();
        state.base.decimals = decimals;
        state.base.is_initialized = true;
        state.pack_base();
        state.init_account_type().unwrap();

        let extension = state
            .init_extension::<ScaledUiAmountConfig>(true)
            .unwrap();
        extension.multiplier = PodF64::from(multiplier);
        extension.new_multiplier = PodF64::from(new_multiplier);
        extension.new_multiplier_effective_timestamp = UnixTimestamp::from(effective_timestamp);

        buffer
    }

    fn build_mint_without_scaled_ui(decimals: u8) -> Vec<u8> {
        let mut buffer = vec![0u8; Token2022Mint::LEN];
        let mut state = StateWithExtensionsMut::<Token2022Mint>::unpack_uninitialized(&mut buffer)
            .unwrap();
        state.base.decimals = decimals;
        state.base.is_initialized = true;
        state.pack_base();
        buffer
    }

    #[test]
    fn reads_nvdax_fixture() {
        let data = build_mint_with_scaled_ui(
            NVDAX_DECIMALS,
            NVDAX_MULTIPLIER,
            NVDAX_NEW_MULTIPLIER,
            NVDAX_EFFECTIVE_TS,
        );
        let config = read_scaled_ui_config(&data).unwrap();
        assert_eq!(f64::from(config.multiplier), NVDAX_MULTIPLIER);
        assert_eq!(f64::from(config.new_multiplier), NVDAX_NEW_MULTIPLIER);
        assert_eq!(
            i64::from(config.new_multiplier_effective_timestamp),
            NVDAX_EFFECTIVE_TS
        );
    }

    #[test]
    fn reads_nvdaon_fixture() {
        let data = build_mint_with_scaled_ui(
            NVDAON_DECIMALS,
            NVDAON_MULTIPLIER,
            NVDAON_NEW_MULTIPLIER,
            NVDAON_EFFECTIVE_TS,
        );
        let config = read_scaled_ui_config(&data).unwrap();
        assert_eq!(f64::from(config.multiplier), NVDAON_MULTIPLIER);
        assert_eq!(f64::from(config.new_multiplier), NVDAON_NEW_MULTIPLIER);
    }

    #[test]
    fn errors_when_extension_missing() {
        let data = build_mint_without_scaled_ui(NVDAX_DECIMALS);
        let result = read_scaled_ui_config(&data);
        assert!(result.is_err());
    }

    #[test]
    fn selects_new_multiplier_once_effective_timestamp_passed() {
        let data = build_mint_with_scaled_ui(
            NVDAX_DECIMALS,
            NVDAX_MULTIPLIER,
            NVDAX_NEW_MULTIPLIER,
            NVDAX_EFFECTIVE_TS,
        );
        let config = read_scaled_ui_config(&data).unwrap();

        // Per CONTEXT.md, NOW_AFTER_BOTH is in the past relative to no
        // timestamp here, so new_multiplier is live.
        let fixed = current_multiplier_fixed(&config, NOW_AFTER_BOTH).unwrap();
        let expected = (NVDAX_NEW_MULTIPLIER * MULTIPLIER_SCALE as f64).round() as u128;
        assert_eq!(fixed, expected);
    }

    #[test]
    fn selects_old_multiplier_before_effective_timestamp() {
        let data = build_mint_with_scaled_ui(
            NVDAX_DECIMALS,
            NVDAX_MULTIPLIER,
            NVDAX_NEW_MULTIPLIER,
            NVDAX_EFFECTIVE_TS,
        );
        let config = read_scaled_ui_config(&data).unwrap();

        let fixed = current_multiplier_fixed(&config, NVDAX_EFFECTIVE_TS - 1).unwrap();
        let expected = (NVDAX_MULTIPLIER * MULTIPLIER_SCALE as f64).round() as u128;
        assert_eq!(fixed, expected);
    }

    #[test]
    fn selects_new_multiplier_exactly_at_effective_timestamp() {
        let data = build_mint_with_scaled_ui(
            NVDAX_DECIMALS,
            NVDAX_MULTIPLIER,
            NVDAX_NEW_MULTIPLIER,
            NVDAX_EFFECTIVE_TS,
        );
        let config = read_scaled_ui_config(&data).unwrap();

        let fixed = current_multiplier_fixed(&config, NVDAX_EFFECTIVE_TS).unwrap();
        let expected = (NVDAX_NEW_MULTIPLIER * MULTIPLIER_SCALE as f64).round() as u128;
        assert_eq!(fixed, expected);
    }

    #[test]
    fn nvdaon_has_no_pending_change() {
        // multiplier == new_multiplier for NVDAon, so the branch should not
        // matter.
        let data = build_mint_with_scaled_ui(
            NVDAON_DECIMALS,
            NVDAON_MULTIPLIER,
            NVDAON_NEW_MULTIPLIER,
            NVDAON_EFFECTIVE_TS,
        );
        let config = read_scaled_ui_config(&data).unwrap();

        let before = current_multiplier_fixed(&config, NVDAON_EFFECTIVE_TS - 1).unwrap();
        let after = current_multiplier_fixed(&config, NOW_AFTER_BOTH).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn rate_reflects_context_thesis() {
        // Both tokens represent one share of NVIDIA. NVDAon's multiplier
        // carries slightly more economic value per raw unit once decimals
        // are normalised. This test checks the rate from NVDAx to NVDAon
        // reflects the difference between the two multipliers in CONTEXT.md,
        // which is 0.140 basis points, not the 1.40 basis points its prose
        // states: 1.4028e-5 relative, or 14.03 parts per million.
        let nvdax_data = build_mint_with_scaled_ui(
            NVDAX_DECIMALS,
            NVDAX_MULTIPLIER,
            NVDAX_NEW_MULTIPLIER,
            NVDAX_EFFECTIVE_TS,
        );
        let nvdaon_data = build_mint_with_scaled_ui(
            NVDAON_DECIMALS,
            NVDAON_MULTIPLIER,
            NVDAON_NEW_MULTIPLIER,
            NVDAON_EFFECTIVE_TS,
        );

        let nvdax_config = read_scaled_ui_config(&nvdax_data).unwrap();
        let nvdaon_config = read_scaled_ui_config(&nvdaon_data).unwrap();

        let now = NOW_AFTER_BOTH;
        let nvdax_mult = current_multiplier_fixed(&nvdax_config, now).unwrap();
        let nvdaon_mult = current_multiplier_fixed(&nvdaon_config, now).unwrap();

        let rate_x_to_on =
            compute_rate(nvdax_mult, NVDAX_DECIMALS, nvdaon_mult, NVDAON_DECIMALS).unwrap();

        // One equity-share-equivalent unit of NVDAx (10^8 raw units, since
        // NVDAx has 8 decimals) converts to just under 10^9 raw units of
        // NVDAon (NVDAon has 9 decimals): NVDAx's live multiplier
        // (1.001701196801074) is very slightly smaller than NVDAon's
        // (1.0017152487959897), so each NVDAon raw unit is worth marginally
        // more and marginally fewer of them are owed.
        let one_nvdax_equity_unit: u64 = 10u64.pow(NVDAX_DECIMALS as u32);
        let out = convert_amount(one_nvdax_equity_unit, rate_x_to_on).unwrap();

        let expected_f64 = (one_nvdax_equity_unit as f64) * NVDAX_NEW_MULTIPLIER
            / NVDAON_NEW_MULTIPLIER
            * 10f64.powi(NVDAON_DECIMALS as i32 - NVDAX_DECIMALS as i32);

        let diff = (out as f64 - expected_f64).abs();
        assert!(
            diff / expected_f64 < 1e-9,
            "rate diverged from float reference: out={out} expected={expected_f64}"
        );
    }

    #[test]
    fn compute_rate_rejects_zero_multiplier() {
        assert!(compute_rate(0, 8, MULTIPLIER_SCALE, 9).is_err());
        assert!(compute_rate(MULTIPLIER_SCALE, 8, 0, 9).is_err());
    }

    #[test]
    fn compute_rate_rejects_a_rate_that_truncates_to_zero() {
        // Both multipliers are non-zero, but mult_a is so much smaller than
        // mult_b that the rate underflows to zero. Returning it would make
        // every conversion built on it silently yield nothing, so it has to
        // be an error instead.
        assert!(compute_rate(1, 8, MULTIPLIER_SCALE, 8).is_err());

        // The same underflow reached through a wide decimals gap rather
        // than through the multipliers.
        assert!(compute_rate(1, 9, MULTIPLIER_SCALE, 8).is_err());

        // The realistic pairing stays comfortably above zero.
        assert!(compute_rate(MULTIPLIER_SCALE, 8, MULTIPLIER_SCALE, 9).is_ok());
    }

    /// Reads both CONTEXT.md fixtures and returns their live multipliers in
    /// fixed point, as the vault instructions would at deposit or withdraw
    /// time.
    fn live_multipliers() -> (u128, u128) {
        let nvdax_data = build_mint_with_scaled_ui(
            NVDAX_DECIMALS,
            NVDAX_MULTIPLIER,
            NVDAX_NEW_MULTIPLIER,
            NVDAX_EFFECTIVE_TS,
        );
        let nvdaon_data = build_mint_with_scaled_ui(
            NVDAON_DECIMALS,
            NVDAON_MULTIPLIER,
            NVDAON_NEW_MULTIPLIER,
            NVDAON_EFFECTIVE_TS,
        );
        let nvdax_config = read_scaled_ui_config(&nvdax_data).unwrap();
        let nvdaon_config = read_scaled_ui_config(&nvdaon_data).unwrap();
        (
            current_multiplier_fixed(&nvdax_config, NOW_AFTER_BOTH).unwrap(),
            current_multiplier_fixed(&nvdaon_config, NOW_AFTER_BOTH).unwrap(),
        )
    }

    /// Economic quantity of the underlying held by `amount` raw units of a
    /// wrapper, expressed exactly as an integer in units of 1e-27 shares.
    /// Integer only: this is the invariant the vault must preserve, so
    /// checking it must not itself round.
    fn equity_value_1e27(amount: u64, decimals: u8, mult_fixed: u128) -> u128 {
        // amount * mult_fixed / (MULTIPLIER_SCALE * 10^decimals) is the value
        // in shares. Multiplying through by MULTIPLIER_SCALE * 10^9 clears
        // both divisions for any wrapper with 9 or fewer decimals.
        let lift = 10u128.pow(9 - decimals as u32);
        (amount as u128) * mult_fixed * lift
    }

    /// One unit-share of NVDAx, in raw units, since NVDAx has 8 decimals.
    const ONE_NVDAX_SHARE: u64 = 100_000_000;

    #[test]
    fn vault_round_trip_preserves_equity_value_across_wrappers() {
        // The property: deposit NVDAx, withdraw NVDAon, and the holder still
        // has the same economic quantity of NVIDIA. NVDAx and NVDAon carry
        // different multipliers and different decimals, so this only holds
        // because each leg applies that wrapper's own multiplier.
        let (mult_nvdax, mult_nvdaon) = live_multipliers();

        let equity_units =
            to_equity_units(ONE_NVDAX_SHARE, NVDAX_DECIMALS, mult_nvdax).unwrap();
        let out_nvdaon =
            from_equity_units(equity_units, NVDAON_DECIMALS, mult_nvdaon).unwrap();

        let value_in = equity_value_1e27(ONE_NVDAX_SHARE, NVDAX_DECIMALS, mult_nvdax);
        let value_out = equity_value_1e27(out_nvdaon, NVDAON_DECIMALS, mult_nvdaon);

        // Never more out than went in: both legs truncate towards the vault.
        assert!(
            value_out <= value_in,
            "withdrawal returned more equity than was deposited: in={value_in} out={value_out}"
        );

        // The shortfall is rounding dust only. Each leg can lose under one
        // unit of its own output; one equity unit and one raw NVDAon unit
        // are each 1e-9 shares, so the total loss is bounded well under
        // 3e18 in these 1e-27-share units.
        let lost = value_in - value_out;
        assert!(
            lost < 3_000_000_000_000_000_000,
            "round trip lost more than rounding dust: {lost}"
        );
    }

    #[test]
    fn vault_round_trip_does_not_ignore_wrapper_drift() {
        // A wrong implementation would treat the two wrappers as
        // interchangeable and just shift the decimal point, paying out
        // 10^9 raw NVDAon for 10^8 raw NVDAx. That silently hands over more
        // NVIDIA than was deposited, because NVDAon's multiplier is larger.
        let (mult_nvdax, mult_nvdaon) = live_multipliers();

        let equity_units =
            to_equity_units(ONE_NVDAX_SHARE, NVDAX_DECIMALS, mult_nvdax).unwrap();
        let out_nvdaon =
            from_equity_units(equity_units, NVDAON_DECIMALS, mult_nvdaon).unwrap();

        let decimals_only = ONE_NVDAX_SHARE as u128 * 10; // 8 decimals to 9
        assert!(
            (out_nvdaon as u128) < decimals_only,
            "decimal shift alone should overpay relative to the true rate"
        );

        // The gap should be the real multiplier drift: the two multipliers
        // differ by 1.4028e-5 relative, which is 14.03 parts per million.
        // Note this is 0.140 basis points, not the 1.40 basis points
        // CONTEXT.md's prose states; the multiplier values there are what
        // this code uses and they are consistent, it is only that derived
        // figure that is off by a factor of ten. Asserting in ppm here so
        // the unit is unambiguous.
        //
        // Checking the gap lands in this band catches both failure modes:
        // zero would mean the drift was ignored, and a much larger number
        // would mean it was applied twice or in the wrong direction.
        let gap_ppm = (decimals_only - out_nvdaon as u128) * 1_000_000 / decimals_only;
        assert!(
            (10..=20).contains(&gap_ppm),
            "drift should be about 14ppm (0.14bps), got {gap_ppm}ppm"
        );
    }

    #[test]
    fn vault_round_trip_agrees_with_the_direct_swap_rate() {
        // Depositing NVDAx and withdrawing NVDAon must land in the same
        // place as swapping NVDAx for NVDAon at the pair rate, or the two
        // layers would sit at different prices and be arbitrageable against
        // each other. The vault path truncates twice rather than once, so it
        // may come out a raw unit or two lower, never higher.
        let (mult_nvdax, mult_nvdaon) = live_multipliers();

        let equity_units =
            to_equity_units(ONE_NVDAX_SHARE, NVDAX_DECIMALS, mult_nvdax).unwrap();
        let via_vault =
            from_equity_units(equity_units, NVDAON_DECIMALS, mult_nvdaon).unwrap();

        let direct_rate =
            compute_rate(mult_nvdax, NVDAX_DECIMALS, mult_nvdaon, NVDAON_DECIMALS).unwrap();
        let via_swap = convert_amount(ONE_NVDAX_SHARE, direct_rate).unwrap();

        assert!(
            via_vault <= via_swap,
            "vault path paid out more than the direct rate: vault={via_vault} swap={via_swap}"
        );
        assert!(
            via_swap - via_vault <= 2,
            "vault and swap paths diverged by more than rounding: vault={via_vault} swap={via_swap}"
        );
    }

    #[test]
    fn vault_round_trip_in_and_out_of_the_same_wrapper_returns_the_deposit() {
        // The degenerate case: deposit NVDAx, withdraw NVDAx. The holder
        // should get back what they put in, less at most a raw unit of
        // truncation, with no drift introduced by passing through equity
        // units at a different decimal scale (8 in, 9 for equity units).
        let (mult_nvdax, _) = live_multipliers();

        let equity_units =
            to_equity_units(ONE_NVDAX_SHARE, NVDAX_DECIMALS, mult_nvdax).unwrap();
        let back = from_equity_units(equity_units, NVDAX_DECIMALS, mult_nvdax).unwrap();

        assert!(back <= ONE_NVDAX_SHARE, "returned more than deposited");
        assert!(
            ONE_NVDAX_SHARE - back <= 1,
            "same-wrapper round trip lost more than one raw unit: {back}"
        );
    }

    #[test]
    fn vault_round_trip_holds_for_nvdaon_deposits_too() {
        // Same property with the wrappers swapped, so the test is not
        // accidentally passing because of which side happens to have the
        // larger multiplier or the finer decimals.
        let (mult_nvdax, mult_nvdaon) = live_multipliers();

        let one_nvdaon_share: u64 = 1_000_000_000; // NVDAon has 9 decimals
        let equity_units =
            to_equity_units(one_nvdaon_share, NVDAON_DECIMALS, mult_nvdaon).unwrap();
        let out_nvdax = from_equity_units(equity_units, NVDAX_DECIMALS, mult_nvdax).unwrap();

        let value_in = equity_value_1e27(one_nvdaon_share, NVDAON_DECIMALS, mult_nvdaon);
        let value_out = equity_value_1e27(out_nvdax, NVDAX_DECIMALS, mult_nvdax);

        assert!(value_out <= value_in, "withdrawal returned more than deposited");

        // NVDAx has coarser decimals than the equity unit scale, so the
        // final truncation is to a 1e-8 share boundary: up to 10 times
        // coarser than the NVDAon case, hence the wider bound.
        let lost = value_in - value_out;
        assert!(
            lost < 12_000_000_000_000_000_000,
            "round trip lost more than rounding dust: {lost}"
        );
    }

    #[test]
    fn equity_units_are_wrapper_agnostic_for_equal_value_deposits() {
        // The point of the receipt token: two deposits carrying the same
        // economic quantity of NVIDIA, in different wrappers, must mint the
        // same number of receipt tokens. One unit-share of each wrapper is
        // the same quantity of NVIDIA by construction.
        let (mult_nvdax, mult_nvdaon) = live_multipliers();

        let from_nvdax =
            to_equity_units(ONE_NVDAX_SHARE, NVDAX_DECIMALS, mult_nvdax).unwrap();
        let from_nvdaon = to_equity_units(1_000_000_000, NVDAON_DECIMALS, mult_nvdaon).unwrap();

        // They differ only by each wrapper's multiplier, which is the real
        // 0.140bps drift, not by decimals or by scale confusion.
        let drift = from_nvdaon.abs_diff(from_nvdax);
        assert!(
            drift < from_nvdax / 1_000,
            "equal-value deposits minted materially different receipts: \
             nvdax={from_nvdax} nvdaon={from_nvdaon}"
        );
    }
}
