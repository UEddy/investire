use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::error::ParitasError;
use crate::state::{Vault, MAX_SYMBOL_LEN, RECEIPT_DECIMALS, RECEIPT_MINT_SEED, VAULT_SEED};

/// Creates a Vault PDA for an underlying equity symbol, plus the receipt
/// mint it will issue against deposits. The symbol is a label chosen by the
/// caller, not verified against anything on chain; see the Vault doc comment
/// for why. authority is stored, not required to sign here, mirroring
/// register_pair; it is checked at add_wrapper, since adding an accepted
/// wrapper mint is the security sensitive action that can affect existing
/// depositors, not creating an empty vault.
pub fn init_vault(ctx: Context<InitVault>, symbol: String, authority: Pubkey) -> Result<()> {
    require!(!symbol.is_empty(), ParitasError::EmptySymbol);
    require!(symbol.len() <= MAX_SYMBOL_LEN, ParitasError::SymbolTooLong);

    let vault = &mut ctx.accounts.vault;
    vault.symbol = symbol;
    vault.receipt_mint = ctx.accounts.receipt_mint.key();
    vault.authority = authority;
    vault.total_equity_units = 0;
    vault.bump = ctx.bumps.vault;

    Ok(())
}

#[derive(Accounts)]
#[instruction(symbol: String)]
pub struct InitVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, symbol.as_bytes()],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = payer,
        mint::decimals = RECEIPT_DECIMALS,
        mint::authority = vault,
        mint::token_program = token_program,
        seeds = [RECEIPT_MINT_SEED, vault.key().as_ref()],
        bump,
    )]
    pub receipt_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
