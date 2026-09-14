use anchor_lang::prelude::*;
use anchor_spl::token_2022::{transfer_checked, TransferChecked};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::error::ParitasError;
use crate::multiplier;
use crate::state::{Pair, PAIR_SEED};

/// Which side of the pair the caller is depositing.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum SwapDirection {
    AToB,
    BToA,
}

/// Swaps amount_in of one side of the pair for the other, at the true
/// equity-unit rate recomputed from on-chain mint state, minus the pair's fee.
///
/// The fee is taken from amount_in, rounded up so the pool never under
/// collects it. The resulting amount_out is rounded down, so the pool never
/// pays out more value than it took in. min_amount_out enforces the caller's
/// slippage tolerance.
pub fn swap(
    ctx: Context<Swap>,
    direction: SwapDirection,
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    require!(amount_in > 0, ParitasError::ZeroAmount);

    let now = Clock::get()?.unix_timestamp;
    let pair = &ctx.accounts.pair;

    let mint_a_data = ctx.accounts.mint_a.to_account_info();
    let mint_a_data = mint_a_data.try_borrow_data()?;
    let config_a = multiplier::read_scaled_ui_config(&mint_a_data)?;
    let mult_a = multiplier::current_multiplier_fixed(&config_a, now)?;
    drop(mint_a_data);

    let mint_b_data = ctx.accounts.mint_b.to_account_info();
    let mint_b_data = mint_b_data.try_borrow_data()?;
    let config_b = multiplier::read_scaled_ui_config(&mint_b_data)?;
    let mult_b = multiplier::current_multiplier_fixed(&config_b, now)?;
    drop(mint_b_data);

    let (rate, decimals_in, decimals_out) = match direction {
        SwapDirection::AToB => (
            multiplier::compute_rate(mult_a, pair.decimals_a, mult_b, pair.decimals_b)?,
            pair.decimals_a,
            pair.decimals_b,
        ),
        SwapDirection::BToA => (
            multiplier::compute_rate(mult_b, pair.decimals_b, mult_a, pair.decimals_a)?,
            pair.decimals_b,
            pair.decimals_a,
        ),
    };

    let fee_bps = pair.fee_bps as u128;
    let fee_amount = (amount_in as u128)
        .checked_mul(fee_bps)
        .ok_or(ParitasError::MathOverflow)?
        .checked_add(9_999)
        .ok_or(ParitasError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(ParitasError::MathOverflow)?;
    let fee_amount = u64::try_from(fee_amount).map_err(|_| ParitasError::MathOverflow)?;

    let amount_in_after_fee = amount_in
        .checked_sub(fee_amount)
        .ok_or(ParitasError::MathOverflow)?;

    let amount_out = multiplier::convert_amount(amount_in_after_fee, rate)?;
    require!(amount_out >= min_amount_out, ParitasError::SlippageExceeded);

    let mint_a_key = ctx.accounts.mint_a.key();
    let mint_b_key = ctx.accounts.mint_b.key();
    let bump = pair.bump;
    let signer_seeds: &[&[u8]] = &[PAIR_SEED, mint_a_key.as_ref(), mint_b_key.as_ref(), &[bump]];

    let (
        user_source,
        user_destination,
        pool_source,
        pool_destination,
        mint_in,
        mint_out,
    ) = match direction {
        SwapDirection::AToB => (
            ctx.accounts.user_token_a.to_account_info(),
            ctx.accounts.user_token_b.to_account_info(),
            ctx.accounts.pool_a.to_account_info(),
            ctx.accounts.pool_b.to_account_info(),
            ctx.accounts.mint_a.to_account_info(),
            ctx.accounts.mint_b.to_account_info(),
        ),
        SwapDirection::BToA => (
            ctx.accounts.user_token_b.to_account_info(),
            ctx.accounts.user_token_a.to_account_info(),
            ctx.accounts.pool_b.to_account_info(),
            ctx.accounts.pool_a.to_account_info(),
            ctx.accounts.mint_b.to_account_info(),
            ctx.accounts.mint_a.to_account_info(),
        ),
    };

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: user_source,
                mint: mint_in,
                to: pool_source,
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount_in,
        decimals_in,
    )?;

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: pool_destination,
                mint: mint_out,
                to: user_destination,
                authority: ctx.accounts.pair.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount_out,
        decimals_out,
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub user: Signer<'info>,

    #[account(
        seeds = [PAIR_SEED, pair.mint_a.as_ref(), pair.mint_b.as_ref()],
        bump = pair.bump,
    )]
    pub pair: Account<'info, Pair>,

    #[account(address = pair.mint_a)]
    pub mint_a: InterfaceAccount<'info, Mint>,

    #[account(address = pair.mint_b)]
    pub mint_b: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = pair,
        associated_token::token_program = token_program,
    )]
    pub pool_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint_b,
        associated_token::authority = pair,
        associated_token::token_program = token_program,
    )]
    pub pool_b: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_token_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint_b,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_token_b: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}
