use anchor_lang::prelude::*;
use anchor_spl::token_2022::{transfer_checked, TransferChecked};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::error::ParitasError;
use crate::introspection::{scan_execution_transaction, INSTRUCTIONS_SYSVAR};
use crate::schedule_math::keeper_fee;
use crate::state::{
    ExecutionReceipt, Schedule, Vault, Wrapper, EXECUTION_ESCROW_SEED, EXECUTION_SEED,
    SCHEDULE_SEED, VAULT_SEED, WRAPPER_SEED,
};

/// First instruction of a permissionless execution. Pulls the schedule's
/// amount out of the owner's delegated allowance, hands it to the caller to
/// swap, and opens the two accounts settle_execution will close.
///
/// The escrow is the load bearing piece. The swap could just as easily deliver
/// straight into the vault's wrapper ATA, and the spec's requirement that the
/// receiving account be owned by the vault PDA is satisfied either way, but a
/// shared account cannot answer the only question settle_execution actually
/// needs answered: how much arrived because of THIS swap. A balance on a
/// shared account also moves for a concurrent deposit, for another schedule's
/// execution, for a plain transfer someone put earlier in the transaction, and
/// for a deposit reached by CPI where introspection cannot see it. So the
/// destination is a fresh token account, derived from this schedule, created
/// here and closed at the end of the same transaction. Its balance at settle
/// time is exactly what this transaction delivered, with no subtraction and no
/// snapshot to trust. It is still owned by the vault PDA, so the vault is the
/// only authority that can move what lands in it.
///
/// The fee is withheld rather than paid here. The caller receives
/// amount_usdc minus the keeper fee to swap with, and only collects the fee
/// itself in settle_execution, once the shares have actually arrived. A caller
/// who takes the money and walks away gets nothing, because the transaction
/// reverts and the debit reverts with it.
pub fn begin_execution(ctx: Context<BeginExecution>) -> Result<()> {
    let schedule = &ctx.accounts.schedule;

    require!(schedule.active, ParitasError::ScheduleInactive);
    require!(
        schedule.vault == ctx.accounts.vault.key(),
        ParitasError::VaultMismatch
    );

    let now = Clock::get()?.unix_timestamp;
    require!(now >= schedule.next_due_ts, ParitasError::ScheduleNotDue);

    // Refuse to open an execution that is not committed to closing itself.
    // Without this, a caller could land a transaction holding only
    // begin_execution, leaving a receipt and an escrow behind for a later
    // transaction to settle against, which is precisely the stale state
    // settle_execution's introspection exists to reject. Requiring the pair up
    // front means the state can never be stranded in the first place.
    let scan = scan_execution_transaction(&ctx.accounts.instructions_sysvar)?;
    require!(
        scan.begin_index == scan.current_index,
        ParitasError::BeginNotTopLevel
    );

    let vault = &ctx.accounts.vault;
    let fee = keeper_fee(
        schedule.amount_usdc,
        vault.keeper_fee_bps,
        vault.keeper_fee_min,
    )?;
    let swap_amount = schedule
        .amount_usdc
        .checked_sub(fee)
        .ok_or(ParitasError::MathOverflow)?;
    require!(swap_amount > 0, ParitasError::FeeExceedsAmount);

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

    // The schedule PDA signs as the delegate the owner approved on their own
    // token account. The token program, not this program, is what bounds the
    // total: the allowance decrements on every transfer, so an owner who
    // delegated four weeks of buys has delegated exactly four weeks of buys.
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
        swap_amount,
        ctx.accounts.payment_mint.decimals,
    )?;

    let receipt = &mut ctx.accounts.receipt;
    receipt.schedule = ctx.accounts.schedule.key();
    receipt.caller = ctx.accounts.caller.key();
    receipt.wrapper_mint = ctx.accounts.wrapper_mint.key();
    receipt.escrow = ctx.accounts.escrow.key();
    receipt.caller_payment_account = ctx.accounts.caller_payment_account.key();
    receipt.debited_usdc = swap_amount;
    receipt.keeper_fee = fee;
    receipt.due_ts = ctx.accounts.schedule.next_due_ts;
    receipt.bump = ctx.bumps.receipt;

    Ok(())
}

#[derive(Accounts)]
pub struct BeginExecution<'info> {
    /// Untrusted. Anyone may run a due schedule; this signature buys nothing
    /// except the right to pay the rent and collect the fee.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [
            SCHEDULE_SEED,
            schedule.owner.as_ref(),
            schedule.vault.as_ref(),
            &[schedule.schedule_index],
        ],
        bump = schedule.bump,
    )]
    pub schedule: Box<Account<'info, Schedule>>,

    #[account(
        seeds = [VAULT_SEED, vault.symbol.as_bytes()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// Existence at this address is what proves the mint is registered on this
    /// vault, the same allowlist deposit and withdraw rely on.
    #[account(
        seeds = [WRAPPER_SEED, vault.key().as_ref(), wrapper_mint.key().as_ref()],
        bump = wrapper.bump,
    )]
    pub wrapper: Box<Account<'info, Wrapper>>,

    #[account(address = wrapper.mint)]
    pub wrapper_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(address = schedule.payment_mint @ ParitasError::PaymentMintMismatch)]
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: identity only, pinned to the schedule's owner. The owner does
    /// not sign an execution; the delegation on their payment account is what
    /// authorises it.
    #[account(address = schedule.owner @ ParitasError::TokenAccountOwnerMismatch)]
    pub owner: UncheckedAccount<'info>,

    /// Pinned to the account the owner named at create time. The authority
    /// check on top of the pinned address is not redundant: a token account's
    /// owner can be reassigned with SetAuthority after the schedule was made,
    /// and an execution should stop rather than keep debiting an account that
    /// has left the schedule owner's hands.
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
        token::mint = payment_mint,
        token::authority = caller,
        token::token_program = payment_token_program,
    )]
    pub caller_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Destination for the swap. Fresh every execution, so its balance at
    /// settle time is unambiguously what this transaction delivered.
    #[account(
        init,
        payer = caller,
        seeds = [EXECUTION_ESCROW_SEED, schedule.key().as_ref()],
        bump,
        token::mint = wrapper_mint,
        token::authority = vault,
        token::token_program = token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = caller,
        space = 8 + ExecutionReceipt::INIT_SPACE,
        seeds = [EXECUTION_SEED, schedule.key().as_ref()],
        bump,
    )]
    pub receipt: Box<Account<'info, ExecutionReceipt>>,

    /// CHECK: address checked against the instructions sysvar.
    #[account(address = INSTRUCTIONS_SYSVAR)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    /// Token program of the wrapper mints, which are Token-2022.
    pub token_program: Interface<'info, TokenInterface>,
    /// Token program of the payment mint, which need not be the same one.
    pub payment_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[cfg(test)]
mod tests {
    use anchor_lang::prelude::Pubkey;
    use anchor_spl::token_2022::spl_token_2022;

    /// An execution straddles two token programs: the payment mint is USDC,
    /// owned by the classic SPL Token program, while the wrappers and the
    /// receipt mint are Token-2022. begin_execution and settle_execution take
    /// the two as separate accounts and build each CPI against the right one.
    ///
    /// That only works because anchor_spl's token_2022 helpers forward the
    /// program account they are handed into the instruction builder, and the
    /// builder validates it with check_spl_token_program_account, which
    /// accepts either program. Both halves of that are in dependencies, and a
    /// version bump that tightened the check to Token-2022 only would break
    /// the payment leg at runtime on devnet with nothing failing to compile.
    /// These two assertions turn that into a failing test instead.
    #[test]
    fn the_payment_leg_builds_against_the_classic_token_program() {
        let ix = spl_token_2022::instruction::transfer_checked(
            &anchor_spl::token::ID,
            &Pubkey::new_unique(),
            &Pubkey::new_unique(),
            &Pubkey::new_unique(),
            &Pubkey::new_unique(),
            &[],
            5_000_000,
            6,
        )
        .expect("classic SPL Token must be accepted for the USDC leg");

        assert_eq!(
            ix.program_id.to_bytes(),
            anchor_spl::token::ID.to_bytes(),
            "the instruction must be addressed to the program it was built for"
        );
    }

    #[test]
    fn the_wrapper_leg_builds_against_token_2022() {
        let ix = spl_token_2022::instruction::transfer_checked(
            &spl_token_2022::ID,
            &Pubkey::new_unique(),
            &Pubkey::new_unique(),
            &Pubkey::new_unique(),
            &Pubkey::new_unique(),
            &[],
            100_000_000,
            8,
        )
        .expect("Token-2022 must be accepted for the wrapper leg");

        assert_eq!(ix.program_id.to_bytes(), spl_token_2022::ID.to_bytes());
        assert_ne!(
            spl_token_2022::ID.to_bytes(),
            anchor_spl::token::ID.to_bytes(),
            "the two legs must be distinct programs, or this all collapses"
        );
    }
}
