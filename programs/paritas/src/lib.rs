use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod introspection;
pub mod multiplier;
pub mod schedule_math;
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

    pub fn init_vault(
        ctx: Context<InitVault>,
        symbol: String,
        authority: Pubkey,
        keeper_fee_bps: u16,
        keeper_fee_min: u64,
    ) -> Result<()> {
        instructions::init_vault(ctx, symbol, authority, keeper_fee_bps, keeper_fee_min)
    }

    pub fn init_receipt_metadata(
        ctx: Context<InitReceiptMetadata>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        instructions::init_receipt_metadata(ctx, name, symbol, uri)
    }

    pub fn set_keeper_fee(
        ctx: Context<SetKeeperFee>,
        keeper_fee_bps: u16,
        keeper_fee_min: u64,
    ) -> Result<()> {
        instructions::set_keeper_fee(ctx, keeper_fee_bps, keeper_fee_min)
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

    pub fn create_schedule(
        ctx: Context<CreateSchedule>,
        schedule_index: u8,
        amount_usdc: u64,
        cadence_seconds: i64,
        first_run_ts: i64,
        min_equity_units: u64,
        floor_tolerance_bps: u16,
    ) -> Result<()> {
        instructions::create_schedule(
            ctx,
            schedule_index,
            amount_usdc,
            cadence_seconds,
            first_run_ts,
            min_equity_units,
            floor_tolerance_bps,
        )
    }

    pub fn cancel_schedule(ctx: Context<CancelSchedule>) -> Result<()> {
        instructions::cancel_schedule(ctx)
    }

    pub fn begin_execution(ctx: Context<BeginExecution>) -> Result<()> {
        instructions::begin_execution(ctx)
    }

    pub fn settle_execution(ctx: Context<SettleExecution>, min_equity_units: u64) -> Result<()> {
        instructions::settle_execution(ctx, min_equity_units)
    }

    pub fn begin_cash_out(
        ctx: Context<BeginCashOut>,
        receipt_amount: u64,
        min_payment_out: u64,
    ) -> Result<()> {
        instructions::begin_cash_out(ctx, receipt_amount, min_payment_out)
    }

    pub fn settle_cash_out(ctx: Context<SettleCashOut>) -> Result<()> {
        instructions::settle_cash_out(ctx)
    }
}
