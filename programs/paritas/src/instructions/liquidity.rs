use anchor_lang::prelude::*;
use anchor_spl::token_2022::{transfer_checked, TransferChecked};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::error::ParitasError;
use crate::state::{Pair, PAIR_SEED};

/// Moves liquidity into one side of a pair's pool.
///
/// This is a deliberately simple single-provider model: there are no LP
/// tokens and no share accounting, so the pair's authority is the one and
/// only liquidity provider and the pool token account balance is the whole
/// of the state. Both sides of a pair are funded by calling this once per
/// mint. Because there is no ledger of who contributed what, deposits from
/// anyone other than the authority could never be reclaimed by them, so
/// this requires the authority to sign, exactly as remove_liquidity does.
pub fn add_liquidity(ctx: Context<AddLiquidity>, amount: u64) -> Result<()> {
    require!(amount > 0, ParitasError::ZeroAmount);

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.authority_token_account.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.pool.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    Ok(())
}

/// Reclaims liquidity from one side of a pair's pool.
///
/// The counterpart to add_liquidity, under the same single-provider model:
/// no LP tokens, no share accounting, so the pair's stored authority is the
/// only account permitted to withdraw and must sign. Whatever fees the pool
/// has accrued through swaps are simply part of the balance and come back
/// with it.
pub fn remove_liquidity(ctx: Context<RemoveLiquidity>, amount: u64) -> Result<()> {
    require!(amount > 0, ParitasError::ZeroAmount);
    require!(
        ctx.accounts.pool.amount >= amount,
        ParitasError::InsufficientPoolBalance
    );

    let mint_a = ctx.accounts.pair.mint_a;
    let mint_b = ctx.accounts.pair.mint_b;
    let bump = ctx.accounts.pair.bump;
    let signer_seeds: &[&[u8]] = &[PAIR_SEED, mint_a.as_ref(), mint_b.as_ref(), &[bump]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.pool.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.authority_token_account.to_account_info(),
                authority: ctx.accounts.pair.to_account_info(),
            },
            &[signer_seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(
        seeds = [PAIR_SEED, pair.mint_a.as_ref(), pair.mint_b.as_ref()],
        bump = pair.bump,
        has_one = authority @ ParitasError::Unauthorized,
    )]
    pub pair: Account<'info, Pair>,
    pub authority: Signer<'info>,

    /// Either side of the pair. The pool and token accounts below are tied
    /// to whichever one is passed, so one call funds one side.
    #[account(
        constraint = mint.key() == pair.mint_a || mint.key() == pair.mint_b
            @ ParitasError::MintNotInPair
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = pair,
        associated_token::token_program = token_program,
    )]
    pub pool: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = authority,
        associated_token::token_program = token_program,
    )]
    pub authority_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(
        seeds = [PAIR_SEED, pair.mint_a.as_ref(), pair.mint_b.as_ref()],
        bump = pair.bump,
        has_one = authority @ ParitasError::Unauthorized,
    )]
    pub pair: Account<'info, Pair>,
    pub authority: Signer<'info>,

    #[account(
        constraint = mint.key() == pair.mint_a || mint.key() == pair.mint_b
            @ ParitasError::MintNotInPair
    )]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = pair,
        associated_token::token_program = token_program,
    )]
    pub pool: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = authority,
        associated_token::token_program = token_program,
    )]
    pub authority_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}
