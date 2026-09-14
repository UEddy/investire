use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::multiplier;
use crate::state::{Pair, PAIR_SEED};

/// Returns the fixed point exchange rate from token A to token B for this
/// pair, in multiplier::RATE_SCALE units: amount_b = amount_a * rate / RATE_SCALE.
///
/// Recomputes the rate from on-chain mint state on every call. There is no
/// oracle and no cached value; if either mint is missing the
/// ScaledUiAmountConfig extension, this errors instead of guessing.
pub fn get_rate(ctx: Context<GetRate>) -> Result<u128> {
    let now = Clock::get()?.unix_timestamp;

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

    let pair = &ctx.accounts.pair;
    multiplier::compute_rate(mult_a, pair.decimals_a, mult_b, pair.decimals_b)
}

#[derive(Accounts)]
pub struct GetRate<'info> {
    #[account(
        seeds = [PAIR_SEED, pair.mint_a.as_ref(), pair.mint_b.as_ref()],
        bump = pair.bump,
    )]
    pub pair: Account<'info, Pair>,

    #[account(address = pair.mint_a)]
    pub mint_a: InterfaceAccount<'info, Mint>,

    #[account(address = pair.mint_b)]
    pub mint_b: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
}
