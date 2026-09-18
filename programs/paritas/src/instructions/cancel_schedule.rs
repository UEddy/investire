use anchor_lang::prelude::*;

use crate::error::ParitasError;
use crate::state::{Schedule, SCHEDULE_SEED};

/// Stops a recurring buy. The owner signs. Nothing is sold, nothing is moved,
/// and the shares already bought stay exactly where they are: they are receipt
/// tokens in the owner's own account, and withdraw is the only thing that
/// touches them.
///
/// The account is left in place rather than closed, so the totals stay
/// readable after cancelling and so the schedule index cannot be reused to
/// create a fresh schedule that inherits this one's history. begin_execution
/// and settle_execution both refuse an inactive schedule, so a keeper holding
/// a delegation cannot keep running it.
///
/// This does not revoke the delegation on the owner's payment account, because
/// this program is not the authority on that account and should not be: the
/// owner revokes with a plain SPL revoke, which works whether or not this
/// program cooperates. Cancelling here is the check the program enforces;
/// revoking is the one that does not depend on the program at all.
pub fn cancel_schedule(ctx: Context<CancelSchedule>) -> Result<()> {
    let schedule = &mut ctx.accounts.schedule;
    require!(schedule.active, ParitasError::ScheduleInactive);
    schedule.active = false;

    Ok(())
}

#[derive(Accounts)]
pub struct CancelSchedule<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ ParitasError::Unauthorized,
        seeds = [
            SCHEDULE_SEED,
            schedule.owner.as_ref(),
            schedule.vault.as_ref(),
            &[schedule.schedule_index],
        ],
        bump = schedule.bump,
    )]
    pub schedule: Account<'info, Schedule>,
}
