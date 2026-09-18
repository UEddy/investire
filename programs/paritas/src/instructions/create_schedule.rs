use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::error::ParitasError;
use crate::state::{
    Schedule, Vault, MAX_FLOOR_TOLERANCE_BPS, MAX_KEEPER_FEE_BPS, MIN_CADENCE_SECONDS,
    SCHEDULE_SEED, VAULT_SEED,
};

/// Creates a recurring buy. The owner signs, and everything an untrusted
/// caller could otherwise choose later is pinned here, while the owner is the
/// one signing: which vault the shares land in, which mint gets debited, how
/// much per run, how often, and the floor on what one run has to deliver.
///
/// Funding is a plain SPL approve the owner sends separately, delegating the
/// schedule PDA on their payment token account. Nothing in this program can
/// move the owner's money beyond that allowance, so the owner caps their total
/// exposure by choosing how much to delegate, and revokes to stop it dead
/// without needing this program's cooperation.
///
/// min_equity_units is the starting floor only. Each execution resets the live
/// floor to what it actually delivered, less floor_tolerance_bps, so the plan
/// does not quietly stop the first time the underlying has risen enough that
/// the owner's original figure is no longer reachable. The owner's value is
/// kept alongside as initial_min_equity_units so the drift stays visible.
///
/// first_run_ts is not bounded. A timestamp in the past just means the first
/// run is due immediately, which is the owner's call to make, and
/// settle_execution's advance clamps next_due_ts forward so a long backdated
/// start cannot be cashed in as a burst of catch up executions.
pub fn create_schedule(
    ctx: Context<CreateSchedule>,
    _schedule_index: u8,
    amount_usdc: u64,
    cadence_seconds: i64,
    first_run_ts: i64,
    min_equity_units: u64,
    floor_tolerance_bps: u16,
) -> Result<()> {
    require!(
        cadence_seconds >= MIN_CADENCE_SECONDS,
        ParitasError::CadenceTooShort
    );
    require!(
        floor_tolerance_bps <= MAX_FLOOR_TOLERANCE_BPS,
        ParitasError::FloorToleranceTooWide
    );

    // The dust floor is one whole unit of the payment mint, read from the
    // mint rather than written here as a raw constant, so it means the same
    // thing whatever decimals the mint uses. Below this, the keeper fee and
    // the rounding down at every conversion eat the buy.
    let dust_floor = 10u64
        .checked_pow(u32::from(ctx.accounts.payment_mint.decimals))
        .ok_or(ParitasError::MathOverflow)?;
    require!(
        amount_usdc >= dust_floor,
        ParitasError::AmountBelowDustFloor
    );

    // A buy too small to pay this vault's minimum keeper fee is one no keeper
    // will ever run, since the fee is capped at MAX_KEEPER_FEE_BPS of the
    // amount however the vault is configured. Better to say so while the owner
    // is still here than to create a schedule that silently never executes.
    let max_payable_fee = (amount_usdc as u128)
        .checked_mul(MAX_KEEPER_FEE_BPS as u128)
        .ok_or(ParitasError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(ParitasError::MathOverflow)?;
    require!(
        max_payable_fee >= ctx.accounts.vault.keeper_fee_min as u128,
        ParitasError::AmountCannotCoverKeeperFee
    );

    let schedule = &mut ctx.accounts.schedule;
    schedule.owner = ctx.accounts.owner.key();
    schedule.vault = ctx.accounts.vault.key();
    schedule.payment_mint = ctx.accounts.payment_mint.key();
    schedule.owner_payment_account = ctx.accounts.owner_payment_account.key();
    schedule.schedule_index = _schedule_index;
    schedule.amount_usdc = amount_usdc;
    schedule.cadence_seconds = cadence_seconds;
    schedule.next_due_ts = first_run_ts;
    schedule.min_equity_units = min_equity_units;
    schedule.initial_min_equity_units = min_equity_units;
    schedule.floor_tolerance_bps = floor_tolerance_bps;
    schedule.executions = 0;
    schedule.total_usdc_spent = 0;
    schedule.total_equity_units = 0;
    schedule.active = true;
    schedule.bump = ctx.bumps.schedule;

    Ok(())
}

#[derive(Accounts)]
#[instruction(schedule_index: u8)]
pub struct CreateSchedule<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, vault.symbol.as_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    pub payment_mint: InterfaceAccount<'info, Mint>,

    /// The owner's payment token account, required here so the address the
    /// owner will delegate against is fixed at creation time rather than
    /// chosen by whoever runs the execution.
    #[account(
        token::mint = payment_mint,
        token::authority = owner,
        token::token_program = payment_token_program,
    )]
    pub owner_payment_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = owner,
        space = 8 + Schedule::INIT_SPACE,
        seeds = [
            SCHEDULE_SEED,
            owner.key().as_ref(),
            vault.key().as_ref(),
            &[schedule_index],
        ],
        bump,
    )]
    pub schedule: Account<'info, Schedule>,

    pub payment_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
