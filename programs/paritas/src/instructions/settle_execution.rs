use anchor_lang::prelude::*;
use anchor_spl::token_2022::{
    close_account, mint_to, transfer_checked, CloseAccount, MintTo, TransferChecked,
};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::error::ParitasError;
use crate::schedule_math::{keeper_fee, next_due_after, ratcheted_floor};
use crate::introspection::{scan_execution_transaction, INSTRUCTIONS_SYSVAR};
use crate::multiplier;
use crate::state::{
    ExecutionReceipt, Schedule, Vault, Wrapper, EXECUTION_SEED, SCHEDULE_SEED, VAULT_SEED,
    WRAPPER_SEED,
};

/// Last instruction of a permissionless execution. Verifies that the swap the
/// caller assembled actually happened, on the right mint, into the right
/// account, for a large enough number of shares, then credits the schedule's
/// owner and pays the caller.
///
/// Everything here assumes the caller is hostile. The caller picked the route,
/// picked the instructions on either side of this one, picked every account
/// this program does not pin, and picked min_equity_units. So min_equity_units
/// is treated as what it is: a tightening the caller may apply to their own
/// transaction, never the protection itself. The protection is
/// schedule.min_equity_units, which only the owner's signature can set.
///
/// The shape of the proof is: the escrow token account did not exist before
/// this transaction, this program created it in this transaction, and it is
/// about to be closed in this transaction. Whatever is in it is what this
/// transaction's swap delivered. No before and after subtraction, no shared
/// balance to reason about, and nothing a CPI in some other instruction can
/// quietly add to the number.
pub fn settle_execution(ctx: Context<SettleExecution>, min_equity_units: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // Instruction introspection. The scan requires the transaction to hold
    // exactly one begin_execution and exactly one settle_execution, and no
    // other paritas instruction at all.
    //
    // The current index check is not a formality. The sysvar only lists top
    // level instructions, so if this settle_execution were reached by CPI from
    // some other program, the scan would happily describe a different,
    // legitimate looking settle_execution sitting elsewhere in the
    // transaction, and this one would ride along on that proof. Requiring that
    // the instruction at the current index is the settle_execution the scan
    // found is what ties the proof to this invocation.
    let scan = scan_execution_transaction(&ctx.accounts.instructions_sysvar)?;
    require!(
        scan.settle_index == scan.current_index,
        ParitasError::SettleNotTopLevel
    );

    // And the begin_execution the scan found has to be this schedule's. The
    // receipt PDA address is a pure function of the schedule, so finding it
    // among that instruction's accounts identifies the schedule without
    // depending on the position of any account in begin_execution's list.
    let schedule_key = ctx.accounts.schedule.key();
    let receipt_key = ctx.accounts.receipt.key();
    let begin_matches = scan
        .begin
        .accounts
        .iter()
        .any(|meta| meta.pubkey == schedule_key)
        && scan
            .begin
            .accounts
            .iter()
            .any(|meta| meta.pubkey == receipt_key);
    require!(begin_matches, ParitasError::MissingBeginExecution);

    require!(ctx.accounts.schedule.active, ParitasError::ScheduleInactive);
    require!(
        ctx.accounts.schedule.vault == ctx.accounts.vault.key(),
        ParitasError::VaultMismatch
    );
    require!(
        now >= ctx.accounts.schedule.next_due_ts,
        ParitasError::ScheduleNotDue
    );

    // The debited amount matches. The fee is recomputed from the schedule
    // rather than read off the receipt, so the two have to agree, and the
    // recorded due date has to be the one still standing on the schedule.
    // That last check is what makes one due date worth exactly one execution:
    // a second settle_execution against the same receipt would need a
    // next_due_ts this one has already moved.
    let amount_usdc = ctx.accounts.schedule.amount_usdc;
    let fee = keeper_fee(
        amount_usdc,
        ctx.accounts.vault.keeper_fee_bps,
        ctx.accounts.vault.keeper_fee_min,
    )?;
    let swap_amount = amount_usdc
        .checked_sub(fee)
        .ok_or(ParitasError::MathOverflow)?;
    require!(swap_amount > 0, ParitasError::FeeExceedsAmount);

    let receipt = &ctx.accounts.receipt;
    require!(
        receipt.due_ts == ctx.accounts.schedule.next_due_ts,
        ParitasError::ExecutionReceiptMismatch
    );
    require!(
        receipt.debited_usdc == swap_amount,
        ParitasError::ExecutionReceiptMismatch
    );
    require!(
        receipt.keeper_fee == fee,
        ParitasError::ExecutionReceiptMismatch
    );
    require!(
        receipt.wrapper_mint == ctx.accounts.wrapper_mint.key(),
        ParitasError::ExecutionReceiptMismatch
    );

    // What actually arrived, valued at the wrapper's live multiplier. The
    // mint account is pinned to the wrapper allowlist entry, so the multiplier
    // is read from the mint the vault accepted, not from one the caller chose.
    let received = ctx.accounts.escrow.amount;
    require!(received > 0, ParitasError::NothingReceived);

    let mint_account = ctx.accounts.wrapper_mint.to_account_info();
    let mint_data = mint_account.try_borrow_data()?;
    let config = multiplier::read_scaled_ui_config(&mint_data)?;
    let mult_fixed = multiplier::current_multiplier_fixed(&config, now)?;
    drop(mint_data);

    let wrapper_decimals = ctx.accounts.wrapper.decimals;
    let equity_units = multiplier::to_equity_units(received, wrapper_decimals, mult_fixed)?;
    require!(equity_units > 0, ParitasError::ZeroAmount);

    // The owner's floor binds; the caller's argument can only raise it. The
    // stored floor is the ratcheted one, so what is being compared against is
    // the previous execution's realised result less the tolerance, not a
    // figure fixed months ago at a price that no longer exists.
    let floor = ctx
        .accounts
        .schedule
        .min_equity_units
        .max(min_equity_units);
    require!(
        equity_units >= floor,
        ParitasError::MinEquityUnitsNotMet
    );

    let vault_symbol = ctx.accounts.vault.symbol.clone();
    let vault_bump = [ctx.accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, vault_symbol.as_bytes(), &vault_bump];

    // Sweep the escrow into the vault's own holdings, then close it. Both
    // moves are signed by the vault PDA, which is the escrow's authority, so
    // the caller never has a claim on what the swap delivered.
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.escrow.to_account_info(),
                mint: ctx.accounts.wrapper_mint.to_account_info(),
                to: ctx.accounts.vault_wrapper_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        received,
        wrapper_decimals,
    )?;

    close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.caller.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        &[vault_seeds],
    ))?;

    // Credit goes to the schedule's owner. The destination is the owner's
    // associated receipt account, derived from schedule.owner, so there is no
    // account the caller could substitute to redirect the shares.
    mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.receipt_mint.to_account_info(),
                to: ctx.accounts.owner_receipt_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ),
        equity_units,
    )?;

    let vault = &mut ctx.accounts.vault;
    vault.total_equity_units = vault
        .total_equity_units
        .checked_add(equity_units as u128)
        .ok_or(ParitasError::MathOverflow)?;

    // Advance the due date, then clamp it forward if it is still in the past.
    // A schedule that went unrun for a year has one buy owed, not fifty two:
    // without the clamp, a keeper could run the backlog back to back and empty
    // whatever allowance the owner had left standing in an afternoon.
    let schedule = &mut ctx.accounts.schedule;
    schedule.next_due_ts = next_due_after(schedule.next_due_ts, schedule.cadence_seconds, now)?;

    // Ratchet the floor onto what this execution actually bought. This is the
    // only writer of min_equity_units after creation, and it runs only once
    // the delivery has already cleared the previous floor, so the floor can
    // never be reset from a result that was itself rejected.
    schedule.min_equity_units = ratcheted_floor(equity_units, schedule.floor_tolerance_bps)?;

    schedule.executions = schedule
        .executions
        .checked_add(1)
        .ok_or(ParitasError::MathOverflow)?;
    schedule.total_usdc_spent = schedule
        .total_usdc_spent
        .checked_add(amount_usdc)
        .ok_or(ParitasError::MathOverflow)?;
    schedule.total_equity_units = schedule
        .total_equity_units
        .checked_add(equity_units as u128)
        .ok_or(ParitasError::MathOverflow)?;

    // The caller is paid last, after every check has passed and the shares are
    // already the owner's. A caller who takes the money and skips the swap
    // never reaches this line, because the transaction that would have paid
    // them reverts, and the debit in begin_execution reverts with it.
    if fee > 0 {
        let owner_key = schedule.owner;
        let vault_key = schedule.vault;
        let schedule_index = [schedule.schedule_index];
        let schedule_bump = [schedule.bump];
        let schedule_seeds: &[&[u8]] = &[
            SCHEDULE_SEED,
            owner_key.as_ref(),
            vault_key.as_ref(),
            &schedule_index,
            &schedule_bump,
        ];

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.payment_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.owner_payment_account.to_account_info(),
                    mint: ctx.accounts.payment_mint.to_account_info(),
                    to: ctx.accounts.caller_payment_account.to_account_info(),
                    authority: ctx.accounts.schedule.to_account_info(),
                },
                &[schedule_seeds],
            ),
            fee,
            ctx.accounts.payment_mint.decimals,
        )?;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct SettleExecution<'info> {
    /// Untrusted. Receives the escrow and receipt rent back, and the keeper
    /// fee, and nothing else.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [
            SCHEDULE_SEED,
            schedule.owner.as_ref(),
            schedule.vault.as_ref(),
            &[schedule.schedule_index],
        ],
        bump = schedule.bump,
    )]
    pub schedule: Box<Account<'info, Schedule>>,

    /// Written by begin_execution earlier in this same transaction, and closed
    /// here. Its address is derived from the schedule, so it cannot be a
    /// receipt belonging to some other schedule, and the caller equality check
    /// keeps the rent and the fee flowing back to whoever opened the execution.
    #[account(
        mut,
        close = caller,
        seeds = [EXECUTION_SEED, schedule.key().as_ref()],
        bump = receipt.bump,
        constraint = receipt.schedule == schedule.key() @ ParitasError::ExecutionReceiptMismatch,
        constraint = receipt.caller == caller.key() @ ParitasError::ExecutionReceiptMismatch,
    )]
    pub receipt: Box<Account<'info, ExecutionReceipt>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.symbol.as_bytes()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// Existence at this address is the proof that the mint the swap delivered
    /// is one this vault accepts.
    #[account(
        seeds = [WRAPPER_SEED, vault.key().as_ref(), wrapper_mint.key().as_ref()],
        bump = wrapper.bump,
    )]
    pub wrapper: Box<Account<'info, Wrapper>>,

    #[account(address = wrapper.mint)]
    pub wrapper_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Pinned to the address begin_execution created and recorded. That
    /// account was opened with seeds and a bump in the same transaction, so
    /// the address comparison here is enough and there is no reason to spend
    /// the compute rederiving it. Owned by the vault PDA, as required.
    #[account(
        mut,
        address = receipt.escrow @ ParitasError::ExecutionReceiptMismatch,
        token::mint = wrapper_mint,
        token::authority = vault,
        token::token_program = token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = wrapper_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_wrapper_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, address = vault.receipt_mint)]
    pub receipt_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: identity only, pinned to the schedule's owner. The owner does
    /// not sign an execution.
    #[account(address = schedule.owner @ ParitasError::TokenAccountOwnerMismatch)]
    pub owner: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = receipt_mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program,
    )]
    pub owner_receipt_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = schedule.payment_mint @ ParitasError::PaymentMintMismatch)]
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        address = schedule.owner_payment_account @ ParitasError::TokenAccountOwnerMismatch,
        token::mint = payment_mint,
        token::authority = owner,
        token::token_program = payment_token_program,
    )]
    pub owner_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        address = receipt.caller_payment_account @ ParitasError::ExecutionReceiptMismatch,
        token::mint = payment_mint,
        token::authority = caller,
        token::token_program = payment_token_program,
    )]
    pub caller_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: address checked against the instructions sysvar.
    #[account(address = INSTRUCTIONS_SYSVAR)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    /// Token program of the wrapper and receipt mints, which are Token-2022.
    pub token_program: Interface<'info, TokenInterface>,
    /// Token program of the payment mint, which need not be the same one.
    pub payment_token_program: Interface<'info, TokenInterface>,
}
