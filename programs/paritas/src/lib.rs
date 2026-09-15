use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod multiplier;
pub mod state;

use instructions::*;

declare_id!("5QkWw7s4dQwAhNZQoKGDTrb6xqcZnMi8XPA7tAkD29LV");

#[program]
pub mod paritas {
    use super::*;

    pub fn register_pair(ctx: Context<RegisterPair>, fee_bps: u16, authority: Pubkey) -> Result<()> {
        instructions::register_pair(ctx, fee_bps, authority)
    }

    pub fn get_rate(ctx: Context<GetRate>) -> Result<u128> {
        instructions::get_rate(ctx)
    }

    pub fn swap(
        ctx: Context<Swap>,
        direction: SwapDirection,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        instructions::swap(ctx, direction, amount_in, min_amount_out)
    }

    pub fn add_liquidity(ctx: Context<AddLiquidity>, amount: u64) -> Result<()> {
        instructions::add_liquidity(ctx, amount)
    }

    pub fn remove_liquidity(ctx: Context<RemoveLiquidity>, amount: u64) -> Result<()> {
        instructions::remove_liquidity(ctx, amount)
    }

    pub fn init_vault(ctx: Context<InitVault>, symbol: String, authority: Pubkey) -> Result<()> {
        instructions::init_vault(ctx, symbol, authority)
    }

    pub fn add_wrapper(ctx: Context<AddWrapper>) -> Result<()> {
        instructions::add_wrapper(ctx)
    }

    pub fn deposit(ctx: Context<Deposit>, amount_in: u64) -> Result<()> {
        instructions::deposit(ctx, amount_in)
    }

    pub fn withdraw(ctx: Context<Withdraw>, receipt_amount: u64) -> Result<()> {
        instructions::withdraw(ctx, receipt_amount)
    }
}
