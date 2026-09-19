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
    let accounts = ctx.accounts;
    pay_out_wrapper(PayOut {
        vault: &mut accounts.vault,
        wrapper: &accounts.wrapper,
        wrapper_mint: &accounts.wrapper_mint,
        vault_wrapper_account: &accounts.vault_wrapper_account,
        destination: &accounts.user_wrapper_account,
        receipt_mint: &accounts.receipt_mint,
        user_receipt_account: &accounts.user_receipt_account,
        user: &accounts.user,
        token_program: &accounts.token_program,
        receipt_amount,
    })?;
    Ok(())
}

/// Everything pay_out_wrapper touches, borrowed from whichever instruction's
/// accounts it is called with.
pub struct PayOut<'a, 'info> {
    pub vault: &'a mut Account<'info, Vault>,
    pub wrapper: &'a Account<'info, Wrapper>,
    pub wrapper_mint: &'a InterfaceAccount<'info, Mint>,
    pub vault_wrapper_account: &'a InterfaceAccount<'info, TokenAccount>,
    pub destination: &'a InterfaceAccount<'info, TokenAccount>,
    pub receipt_mint: &'a InterfaceAccount<'info, Mint>,
    pub user_receipt_account: &'a InterfaceAccount<'info, TokenAccount>,
    pub user: &'a Signer<'info>,
    pub token_program: &'a Interface<'info, TokenInterface>,
    pub receipt_amount: u64,
}

/// The core of withdraw, shared with begin_cash_out: burn receipt_amount of
/// the user's receipt tokens and pay out the same equity as raw wrapper, at
/// that wrapper's own live multiplier. Returns the raw amount paid.
///
/// One implementation for both on purpose. The vault's safety in a cash out
/// is exactly its safety in a withdraw, receipts burned against wrapper paid
/// out at the multiplier, and keeping one copy of that arithmetic means there
/// is one copy to audit and no way for the two to drift.
pub fn pay_out_wrapper(p: PayOut) -> Result<u64> {
    require!(p.receipt_amount > 0, ParitasError::ZeroAmount);

    let now = Clock::get()?.unix_timestamp;

    let mint_info = p.wrapper_mint.to_account_info();
    let mint_data = mint_info.try_borrow_data()?;
    let config = multiplier::read_scaled_ui_config(&mint_data)?;
    let mult_fixed = multiplier::current_multiplier_fixed(&config, now)?;
    drop(mint_data);

    let wrapper_decimals = p.wrapper.decimals;
    let amount_out =
        multiplier::from_equity_units(p.receipt_amount, wrapper_decimals, mult_fixed)?;
    require!(amount_out > 0, ParitasError::ZeroAmount);

    require!(
        p.vault_wrapper_account.amount >= amount_out,
        ParitasError::InsufficientVaultBalance
    );

    burn(
        CpiContext::new(
            p.token_program.to_account_info(),
            Burn {
                mint: p.receipt_mint.to_account_info(),
                from: p.user_receipt_account.to_account_info(),
                authority: p.user.to_account_info(),
            },
        ),
        p.receipt_amount,
    )?;

    let symbol_bytes = p.vault.symbol.as_bytes().to_vec();
    let bump = p.vault.bump;
    let signer_seeds: &[&[u8]] = &[VAULT_SEED, &symbol_bytes, &[bump]];

    transfer_checked(
        CpiContext::new_with_signer(
            p.token_program.to_account_info(),
            TransferChecked {
                from: p.vault_wrapper_account.to_account_info(),
                mint: p.wrapper_mint.to_account_info(),
                to: p.destination.to_account_info(),
                authority: p.vault.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount_out,
        wrapper_decimals,
    )?;

    p.vault.total_equity_units = p
        .vault
        .total_equity_units
        .checked_sub(p.receipt_amount as u128)
        .ok_or(ParitasError::MathOverflow)?;

    Ok(amount_out)
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
