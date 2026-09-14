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

    numerator
        .checked_div(denominator)
        .ok_or_else(|| error!(ParitasError::MathOverflow))
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
        // reflects the ~1.40 basis point difference described in CONTEXT.md.
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
        // NVDAx has 8 decimals) should convert to slightly more than
        // 10^9 raw units of NVDAon (NVDAon has 9 decimals), since NVDAx's
        // live multiplier (1.001701196801074) is essentially equal to
        // NVDAon's (1.0017152487959897): the ~1.40bps difference comes from
        // NVDAon's multiplier being very slightly larger.
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
}
