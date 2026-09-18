use anchor_lang::prelude::*;

use crate::error::ParitasError;
use crate::state::MAX_KEEPER_FEE_BPS;

/// The permissionless caller's cut of one execution.
///
/// Basis points alone do not work at savings-app sizes. A quarter of a percent
/// of a five dollar buy is about a cent, which does not cover a priority fee
/// on a congested slot, so the fee has an absolute floor as well and the
/// caller is paid whichever is larger. The vault authority sets both.
///
/// Both are then clamped to MAX_KEEPER_FEE_BPS of the amount. The clamp is not
/// a detail: the fee comes out of a schedule owner's money, and the owner
/// agreed to a vault, not to whatever number that vault's authority sets
/// tomorrow. It also makes the floor safe on its own terms, since a minimum
/// larger than the buy could otherwise consume the whole execution.
///
/// Rounded down at every step, so the caller is never paid more than the
/// stated rate. begin_execution withholds this and settle_execution pays it,
/// and both compute it here rather than reading it off the execution receipt,
/// which is what lets settle_execution compare the two and reject a receipt
/// claiming a different figure.
pub fn keeper_fee(amount_usdc: u64, fee_bps: u16, fee_min: u64) -> Result<u64> {
    let from_bps = (amount_usdc as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(ParitasError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(ParitasError::MathOverflow)?;

    let ceiling = (amount_usdc as u128)
        .checked_mul(MAX_KEEPER_FEE_BPS as u128)
        .ok_or(ParitasError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(ParitasError::MathOverflow)?;

    let fee = from_bps.max(fee_min as u128).min(ceiling);
    u64::try_from(fee).map_err(|_| error!(ParitasError::MathOverflow))
}

/// The floor the next execution must clear, given what this one delivered.
///
/// The floor tracks the underlying instead of being fixed at creation: a fixed
/// floor is priced in shares, and the shares a fixed sum buys fall as the
/// underlying rises, so a fixed floor eventually rejects every honest
/// execution and the plan stops without anyone deciding it should. Resetting
/// from the realised result each time keeps it in the right neighbourhood
/// however far the price has moved.
///
/// Rounded down, so the tolerance is never quietly narrower than stated.
pub fn ratcheted_floor(realised_equity_units: u64, tolerance_bps: u16) -> Result<u64> {
    let keep_bps = 10_000u128
        .checked_sub(tolerance_bps as u128)
        .ok_or(ParitasError::MathOverflow)?;

    let floor = (realised_equity_units as u128)
        .checked_mul(keep_bps)
        .ok_or(ParitasError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(ParitasError::MathOverflow)?;

    u64::try_from(floor).map_err(|_| error!(ParitasError::MathOverflow))
}

/// The due date one execution moves a schedule to.
///
/// Normally this is just the previous due date plus the cadence, which keeps
/// a weekly plan on its weekday however late in the day it ran. The clamp
/// matters when a schedule has been missed for a long stretch, either because
/// no keeper ran it or because it was created with a backdated first run: a
/// plain addition would leave next_due_ts in the past, so the schedule would
/// be immediately due again, and a keeper could work through a year of missed
/// buys back to back and empty whatever allowance the owner had standing.
/// Clamping forward means a missed year is worth one buy, not fifty two.
pub fn next_due_after(previous_due_ts: i64, cadence_seconds: i64, now: i64) -> Result<i64> {
    let next = previous_due_ts
        .checked_add(cadence_seconds)
        .ok_or(ParitasError::MathOverflow)?;

    if next > now {
        return Ok(next);
    }

    now.checked_add(cadence_seconds)
        .ok_or_else(|| error!(ParitasError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::MAX_FLOOR_TOLERANCE_BPS;

    const WEEK: i64 = 7 * 24 * 3_600;

    // Five dollars at six decimals, the shape SPEC.md describes.
    const FIVE_DOLLARS: u64 = 5_000_000;

    #[test]
    fn keeper_fee_is_the_stated_basis_points_when_they_clear_the_minimum() {
        assert_eq!(keeper_fee(FIVE_DOLLARS, 25, 0).unwrap(), 12_500); // 1.25 cents
    }

    #[test]
    fn the_minimum_takes_over_when_basis_points_are_too_small_to_matter() {
        // The case that motivated it: a cent will not land a transaction on a
        // congested slot, so the vault authority sets a five cent floor.
        let five_cents = 50_000;
        assert_eq!(keeper_fee(FIVE_DOLLARS, 25, five_cents).unwrap(), five_cents);
    }

    #[test]
    fn the_larger_of_the_two_wins_in_both_directions() {
        let big_buy = 1_000_000_000; // one thousand dollars
        // Basis points now dwarf the floor, so the floor stops binding.
        assert_eq!(keeper_fee(big_buy, 25, 50_000).unwrap(), 2_500_000);
    }

    #[test]
    fn the_ceiling_binds_whatever_the_vault_authority_sets() {
        let ceiling = FIVE_DOLLARS * MAX_KEEPER_FEE_BPS as u64 / 10_000;
        // An authority that sets a hostile rate cannot get past the ceiling.
        assert_eq!(keeper_fee(FIVE_DOLLARS, u16::MAX, 0).unwrap(), ceiling);
        // Nor one that sets a hostile absolute minimum.
        assert_eq!(keeper_fee(FIVE_DOLLARS, 0, u64::MAX).unwrap(), ceiling);
    }

    #[test]
    fn the_fee_always_leaves_something_to_swap_with() {
        for amount in [1u64, 999, FIVE_DOLLARS, u64::MAX / 10_000] {
            let fee = keeper_fee(amount, u16::MAX, u64::MAX).unwrap();
            assert!(fee < amount, "fee {fee} consumed the whole buy of {amount}");
        }
    }

    #[test]
    fn keeper_fee_rounds_down() {
        // 399 * 25 / 10000 is 0.9975, which must not round up to 1.
        assert_eq!(keeper_fee(399, 25, 0).unwrap(), 0);
        assert_eq!(keeper_fee(400, 25, 0).unwrap(), 1);
    }

    #[test]
    fn the_floor_follows_the_underlying_up() {
        // A rising share price means a fixed sum buys fewer shares. A static
        // floor would start rejecting honest executions here; the ratchet
        // moves down with the realised result instead.
        let tolerance = 2_000; // 20%
        let mut floor = ratcheted_floor(1_000_000, tolerance).unwrap();
        assert_eq!(floor, 800_000);

        // Price rises 10%, so the next honest execution buys about 10% fewer
        // shares. It must still clear the floor.
        let realised = 909_090;
        assert!(realised >= floor, "an honest execution was rejected");
        floor = ratcheted_floor(realised, tolerance).unwrap();
        assert!(floor < 800_000, "the floor did not follow the price");
    }

    #[test]
    fn the_floor_follows_the_underlying_down_too() {
        let tolerance = 2_000;
        let floor = ratcheted_floor(1_000_000, tolerance).unwrap();
        // Price falls, so the same sum buys more shares, and the floor rises
        // with it rather than staying slack forever.
        let raised = ratcheted_floor(2_000_000, tolerance).unwrap();
        assert!(raised > floor);
    }

    #[test]
    fn a_short_delivery_beyond_the_tolerance_is_rejected() {
        let tolerance = 2_000; // 20%
        let floor = ratcheted_floor(1_000_000, tolerance).unwrap();
        // A caller keeping a quarter of the buy for themselves.
        assert!(750_000 < floor);
        // A caller inside the tolerance passes, which is the price of having
        // no oracle to anchor against.
        assert!(850_000 >= floor);
    }

    #[test]
    fn a_zero_tolerance_demands_at_least_the_previous_result() {
        assert_eq!(ratcheted_floor(1_000_000, 0).unwrap(), 1_000_000);
    }

    #[test]
    fn the_widest_tolerance_still_demands_half() {
        assert_eq!(
            ratcheted_floor(1_000_000, MAX_FLOOR_TOLERANCE_BPS).unwrap(),
            500_000
        );
    }

    #[test]
    fn an_owner_who_set_no_floor_gets_one_from_the_first_execution() {
        // create_schedule accepts zero, meaning the owner declined to pick a
        // starting floor. The first execution still seeds the ratchet.
        let seeded = ratcheted_floor(1_000_000, 2_000).unwrap();
        assert!(seeded > 0);
    }

    #[test]
    fn on_time_execution_keeps_the_original_weekday() {
        // Due Friday, run a few hours late. Next due is the following Friday,
        // not a week from when the keeper happened to get to it.
        let due = 1_800_000_000;
        let now = due + 5 * 3_600;
        assert_eq!(next_due_after(due, WEEK, now).unwrap(), due + WEEK);
    }

    #[test]
    fn a_single_missed_week_still_advances_by_one_cadence() {
        let due = 1_800_000_000;
        let now = due + WEEK + 3_600;
        // due + WEEK is already past, so it clamps rather than leaving the
        // schedule instantly due again.
        assert_eq!(next_due_after(due, WEEK, now).unwrap(), now + WEEK);
    }

    #[test]
    fn a_year_of_backlog_is_worth_one_execution() {
        let due = 1_800_000_000;
        let now = due + 52 * WEEK;
        let next = next_due_after(due, WEEK, now).unwrap();
        assert!(next > now, "a backlog must not leave the schedule due again");
        assert_eq!(next, now + WEEK);
    }

    #[test]
    fn backdated_first_run_cannot_be_cashed_in_as_a_burst() {
        // first_run_ts is unbounded at create time, which is only safe because
        // of this.
        let now = 1_800_000_000;
        let first_run = now - 10 * 365 * 24 * 3_600;
        assert_eq!(next_due_after(first_run, WEEK, now).unwrap(), now + WEEK);
    }

    #[test]
    fn overflow_errors_rather_than_wrapping() {
        assert!(next_due_after(i64::MAX, 1, 0).is_err());
        assert!(next_due_after(0, i64::MAX, i64::MAX).is_err());
    }
}
