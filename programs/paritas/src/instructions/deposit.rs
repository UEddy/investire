use anchor_lang::prelude::*;
use anchor_spl::token_2022::{mint_to, transfer_checked, MintTo, TransferChecked};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::error::ParitasError;
use crate::multiplier;
use crate::state::{Vault, Wrapper, VAULT_SEED, WRAPPER_SEED};

/// Deposits amount_in raw units of a Vault registered wrapper, and mints the
/// depositor exactly that many equity units of receipt token in return.
///
/// The conversion goes through multiplier::to_equity_units, built on the same
/// compute_rate get_rate and swap use. Raw amounts are not comparable across
/// wrappers; equity units are, which is what lets one receipt token stand in
/// for a mix of wrappers of the same underlying.
///
/// Rounds down, favouring the vault: a deposit that would round to zero
/// equity units is rejected rather than silently taking the user's tokens
/// for nothing.
pub fn deposit(ctx: Context<Deposit>, amount_in: u64) -> Result<()> {
    require!(amount_in > 0, ParitasError::ZeroAmount);

    let now = Clock::get()?.unix_timestamp;

    let mint_data = ctx.accounts.wrapper_mint.to_account_info();
    let mint_data = mint_data.try_borrow_data()?;
    let config = multiplier::read_scaled_ui_config(&mint_data)?;
    let mult_fixed = multiplier::current_multiplier_fixed(&config, now)?;
    drop(mint_data);

    let wrapper_decimals = ctx.accounts.wrapper.decimals;
    let equity_units = multiplier::to_equity_units(amount_in, wrapper_decimals, mult_fixed)?;
    require!(equity_units > 0, ParitasError::ZeroAmount);

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_wrapper_account.to_account_info(),
                mint: ctx.accounts.wrapper_mint.to_account_info(),
                to: ctx.accounts.vault_wrapper_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount_in,
        wrapper_decimals,
    )?;

    let symbol_bytes = ctx.accounts.vault.symbol.as_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[u8]] = &[VAULT_SEED, symbol_bytes, &[bump]];

    mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.receipt_mint.to_account_info(),
                to: ctx.accounts.user_receipt_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[signer_seeds],
        ),
        equity_units,
    )?;

    let vault = &mut ctx.accounts.vault;
    vault.total_equity_units = vault
        .total_equity_units
        .checked_add(equity_units as u128)
        .ok_or(ParitasError::MathOverflow)?;

    Ok(())
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.symbol.as_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        seeds = [WRAPPER_SEED, vault.key().as_ref(), wrapper_mint.key().as_ref()],
        bump = wrapper.bump,
    )]
    pub wrapper: Account<'info, Wrapper>,

    #[account(address = wrapper.mint)]
    pub wrapper_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = wrapper_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_wrapper_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = wrapper_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_wrapper_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, address = vault.receipt_mint)]
    pub receipt_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = receipt_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_receipt_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}
