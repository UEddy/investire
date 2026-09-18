use anchor_lang::prelude::*;

use crate::error::ParitasError;
use crate::state::KEEPER_FEE_BPS;

/// The permissionless caller's cut of one execution, rounded down so it never
/// exceeds the stated basis points.
///
/// begin_execution withholds it and settle_execution pays it, and both compute
/// it here from the schedule's own amount rather than reading it off the
/// execution receipt. Recomputing is what lets settle_execution compare the
/// two and reject a receipt that claims a different figure.
pub fn keeper_fee(amount_usdc: u64) -> Result<u64> {
    let fee = (amount_usdc as u128)
        .checked_mul(KEEPER_FEE_BPS as u128)
        .ok_or(ParitasError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(ParitasError::MathOverflow)?;
    u64::try_from(fee).map_err(|_| error!(ParitasError::MathOverflow))
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

    const WEEK: i64 = 7 * 24 * 3_600;

    #[test]
    fn keeper_fee_is_the_stated_basis_points() {
        // Five dollars at six decimals, the shape SPEC.md describes.
        let five_dollars: u64 = 5_000_000;
        assert_eq!(keeper_fee(five_dollars).unwrap(), 12_500); // 1.25 cents
    }

    #[test]
    fn keeper_fee_rounds_down() {
        // 399 * 25 / 10000 is 0.9975, which must not round up to 1.
        assert_eq!(keeper_fee(399).unwrap(), 0);
        assert_eq!(keeper_fee(400).unwrap(), 1);
    }

    #[test]
    fn keeper_fee_never_exceeds_the_amount() {
        for amount in [0u64, 1, 999, 5_000_000, u64::MAX] {
            assert!(keeper_fee(amount).unwrap() < amount.max(1));
        }
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
