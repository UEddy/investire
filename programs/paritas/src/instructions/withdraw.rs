use anchor_lang::prelude::*;
use anchor_spl::token_2022::{burn, transfer_checked, Burn, TransferChecked};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::error::ParitasError;
use crate::multiplier;
use crate::state::{Vault, Wrapper, VAULT_SEED, WRAPPER_SEED};

/// Burns receipt_amount equity units of receipt token and pays out the
/// equivalent raw amount of whichever registered wrapper the caller named,
/// at that wrapper's own effective multiplier.
///
/// multiplier::from_equity_units is the exact inverse of the conversion
/// deposit applies. Deposit NVDAx and withdraw NVDAon and the holder keeps
/// the same economic quantity of NVIDIA throughout: NVDAx's multiplier is
/// applied on the way in, NVDAon's on the way out, so the drift between two
/// wrappers of the same equity is carried through rather than ignored. A
/// naive 1:1 raw transfer, or a decimals-only shift, would silently hand
/// over a different number of shares than was deposited.
///
/// Rounds down, favouring the vault. Errors clearly if the vault does not
/// hold enough of the requested wrapper, since a vault holding a mix of
/// wrappers can be short any single one even when its total equity units
/// are more than sufficient.
pub fn withdraw(ctx: Context<Withdraw>, receipt_amount: u64) -> Result<()> {
    require!(receipt_amount > 0, ParitasError::ZeroAmount);

    let now = Clock::get()?.unix_timestamp;

    let mint_data = ctx.accounts.wrapper_mint.to_account_info();
    let mint_data = mint_data.try_borrow_data()?;
    let config = multiplier::read_scaled_ui_config(&mint_data)?;
    let mult_fixed = multiplier::current_multiplier_fixed(&config, now)?;
    drop(mint_data);

    let wrapper_decimals = ctx.accounts.wrapper.decimals;
    let amount_out = multiplier::from_equity_units(receipt_amount, wrapper_decimals, mult_fixed)?;
    require!(amount_out > 0, ParitasError::ZeroAmount);

    require!(
        ctx.accounts.vault_wrapper_account.amount >= amount_out,
        ParitasError::InsufficientVaultBalance
    );

    burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.receipt_mint.to_account_info(),
                from: ctx.accounts.user_receipt_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        receipt_amount,
    )?;

    let symbol_bytes = ctx.accounts.vault.symbol.as_bytes();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[u8]] = &[VAULT_SEED, symbol_bytes, &[bump]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault_wrapper_account.to_account_info(),
                mint: ctx.accounts.wrapper_mint.to_account_info(),
                to: ctx.accounts.user_wrapper_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount_out,
        wrapper_decimals,
    )?;

    let vault = &mut ctx.accounts.vault;
    vault.total_equity_units = vault
        .total_equity_units
        .checked_sub(receipt_amount as u128)
        .ok_or(ParitasError::MathOverflow)?;

    Ok(())
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
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
