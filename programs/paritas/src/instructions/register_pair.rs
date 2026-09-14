use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::error::ParitasError;
use crate::state::{Pair, MAX_FEE_BPS, PAIR_SEED};

pub fn register_pair(ctx: Context<RegisterPair>, fee_bps: u16, authority: Pubkey) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, ParitasError::FeeTooHigh);

    let pair = &mut ctx.accounts.pair;
    pair.mint_a = ctx.accounts.mint_a.key();
    pair.mint_b = ctx.accounts.mint_b.key();
    pair.decimals_a = ctx.accounts.mint_a.decimals;
    pair.decimals_b = ctx.accounts.mint_b.decimals;
    pair.fee_bps = fee_bps;
    pair.authority = authority;
    pair.bump = ctx.bumps.pair;

    Ok(())
}

#[derive(Accounts)]
pub struct RegisterPair<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub mint_a: InterfaceAccount<'info, Mint>,

    /// mint_b's key must be greater than mint_a's, in sorted byte order. This
    /// is enforced here, not auto-sorted, so the pair PDA address is a pure
    /// function of the two accounts passed in and there is only one correct
    /// account order for callers to use.
    #[account(constraint = mint_a.key() < mint_b.key() @ ParitasError::MintsNotSorted)]
    pub mint_b: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = 8 + Pair::INIT_SPACE,
        seeds = [PAIR_SEED, mint_a.key().as_ref(), mint_b.key().as_ref()],
        bump,
    )]
    pub pair: Account<'info, Pair>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
