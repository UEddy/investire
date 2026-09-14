use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::error::ParitasError;
use crate::state::{Pair, MAX_FEE_BPS, PAIR_SEED};

pub fn register_pair(ctx: Context<RegisterPair>, fee_bps: u16, authority: Pubkey) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, ParitasError::FeeTooHigh);

    let mint_a_key = ctx.accounts.mint_a.key();
    let mint_b_key = ctx.accounts.mint_b.key();
    require!(mint_a_key != mint_b_key, ParitasError::DuplicateMint);

    let (sorted_lo, sorted_hi) = Pair::sorted(mint_a_key, mint_b_key);
    let (decimals_lo, decimals_hi) = if mint_a_key == sorted_lo {
        (ctx.accounts.mint_a.decimals, ctx.accounts.mint_b.decimals)
    } else {
        (ctx.accounts.mint_b.decimals, ctx.accounts.mint_a.decimals)
    };

    let pair = &mut ctx.accounts.pair;
    pair.mint_a = sorted_lo;
    pair.mint_b = sorted_hi;
    pair.decimals_a = decimals_lo;
    pair.decimals_b = decimals_hi;
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
    pub mint_b: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = 8 + Pair::INIT_SPACE,
        seeds = [
            PAIR_SEED,
            Pair::sorted(mint_a.key(), mint_b.key()).0.as_ref(),
            Pair::sorted(mint_a.key(), mint_b.key()).1.as_ref(),
        ],
        bump,
    )]
    pub pair: Account<'info, Pair>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
