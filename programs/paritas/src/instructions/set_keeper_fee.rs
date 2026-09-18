use anchor_lang::prelude::*;

use crate::error::ParitasError;
use crate::state::{Vault, MAX_KEEPER_FEE_BPS, VAULT_SEED};

/// Retunes what a permissionless execution pays its caller.
///
/// This exists so the fee can follow the cost of landing a transaction without
/// a program upgrade. The right number is a network condition, not a constant:
/// too low and no keeper covers its priority fee, so schedules quietly stop
/// running; too high and schedule owners are overpaying for a service that got
/// cheaper.
///
/// Gated on the vault authority, the same gate as add_wrapper and for the same
/// reason: it changes the terms for depositors and schedule owners who are
/// already committed. The authority still cannot take more than
/// MAX_KEEPER_FEE_BPS of an execution, since that ceiling is enforced in the
/// program on every payment rather than stored here. An authority that sets a
/// wild number gets the ceiling, not the number.
///
/// Existing schedules pick the new value up on their next execution. There is
/// no grandfathering, which is the honest arrangement: an owner who dislikes
/// the new terms cancels, and cancelling needs nobody's cooperation.
pub fn set_keeper_fee(
    ctx: Context<SetKeeperFee>,
    keeper_fee_bps: u16,
    keeper_fee_min: u64,
) -> Result<()> {
    require!(
        keeper_fee_bps <= MAX_KEEPER_FEE_BPS,
        ParitasError::FeeTooHigh
    );

    let vault = &mut ctx.accounts.vault;
    vault.keeper_fee_bps = keeper_fee_bps;
    vault.keeper_fee_min = keeper_fee_min;

    Ok(())
}

#[derive(Accounts)]
pub struct SetKeeperFee<'info> {
    #[account(
        mut,
        has_one = authority @ ParitasError::Unauthorized,
        seeds = [VAULT_SEED, vault.symbol.as_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    pub authority: Signer<'info>,
}
