use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::error::ParitasError;
use crate::multiplier;
use crate::state::{Vault, Wrapper, WRAPPER_SEED};

/// Registers an accepted wrapper mint on a Vault. This is an explicit
/// allowlist, the same reasoning as register_pair: symbol resolution is
/// unsafe, so only mints an operator has verified represent the vault's
/// underlying equity may be added. Gated behind the vault's stored
/// authority, unlike register_pair's permissionless registration, because
/// this mutates an existing, potentially already funded Vault that other
/// depositors rely on: an attacker who could add their own mint here could
/// add one with a fabricated multiplier and drain real deposits through it.
///
/// Rejects the mint outright if it has no ScaledUiAmountConfig extension,
/// since deposit and withdraw have no other way to value it.
pub fn add_wrapper(ctx: Context<AddWrapper>) -> Result<()> {
    let mint_data = ctx.accounts.mint.to_account_info();
    let mint_data = mint_data.try_borrow_data()?;
    multiplier::read_scaled_ui_config(&mint_data)?;
    drop(mint_data);

    let wrapper = &mut ctx.accounts.wrapper;
    wrapper.mint = ctx.accounts.mint.key();
    wrapper.decimals = ctx.accounts.mint.decimals;
    wrapper.bump = ctx.bumps.wrapper;

    Ok(())
}

#[derive(Accounts)]
pub struct AddWrapper<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(has_one = authority @ ParitasError::Unauthorized)]
    pub vault: Account<'info, Vault>,
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = 8 + Wrapper::INIT_SPACE,
        seeds = [WRAPPER_SEED, vault.key().as_ref(), mint.key().as_ref()],
        bump,
    )]
    pub wrapper: Account<'info, Wrapper>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
