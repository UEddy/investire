use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    close_account, transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface,
    TransferChecked,
};

use crate::error::ParitasError;
use crate::instructions::withdraw::{pay_out_wrapper, PayOut};
use crate::introspection::{cash_out_pair, scan_pair_transaction, INSTRUCTIONS_SYSVAR};
use crate::state::{
    CashOutReceipt, Vault, Wrapper, CASH_OUT_ESCROW_SEED, CASH_OUT_SEED, VAULT_SEED,
    WRAPPER_SEED,
};

/// First instruction of a cash out: shares to dollars in one transaction the
/// user signs. Pays out the user's shares as wrapper into their own wallet,
/// exactly as withdraw does, and opens the escrow the sale must deliver into.
///
/// The shape mirrors the buy, begin, swap, settle, and for the same reason: a
/// fresh escrow, created here and closed in settle_cash_out, is the only way
/// to know how much THIS sale delivered. Its balance at settle time is the
/// answer, with nothing to subtract and no shared account a concurrent
/// transfer could move.
///
/// What differs is the threat model, and it is worth being exact about. The
/// buy's caller is an untrusted third party spending the owner's delegated
/// money. Here the signer is the user being paid. The vault's exposure ends
/// in this instruction, with receipts burned against wrapper paid at the
/// multiplier, which is withdraw's guarantee and withdraw's code. What the
/// escrow and settle_cash_out add is protection for the user: a route that
/// delivers less than min_payment_out, or nothing, reverts the whole
/// transaction, shares and all.
///
/// The swap is not constrained. It is the user's own sale of the user's own
/// tokens, signed by the user, and the program has no interest in how it is
/// routed, only in what it delivered.
pub fn begin_cash_out(
    ctx: Context<BeginCashOut>,
    receipt_amount: u64,
    min_payment_out: u64,
) -> Result<()> {
    // Refuse to open a cash out that is not committed to closing itself in
    // this transaction, and refuse to run as a CPI, where the scan would be
    // describing some other instruction's surroundings.
    let scan = scan_pair_transaction(&ctx.accounts.instructions_sysvar, cash_out_pair())?;
    require!(
        scan.begin_index == scan.current_index,
        ParitasError::BeginCashOutNotTopLevel
    );

    // A zero minimum would make settle_cash_out's check say nothing at all.
    require!(min_payment_out > 0, ParitasError::ZeroAmount);

    let accounts = ctx.accounts;
    let wrapper_paid = pay_out_wrapper(PayOut {
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

    let receipt = &mut accounts.cash_out_receipt;
    receipt.user = accounts.user.key();
    receipt.vault = accounts.vault.key();
    receipt.wrapper_mint = accounts.wrapper_mint.key();
    receipt.wrapper_paid = wrapper_paid;
    receipt.payment_mint = accounts.payment_mint.key();
    receipt.escrow = accounts.escrow.key();
    receipt.min_payment_out = min_payment_out;
    receipt.bump = ctx.bumps.cash_out_receipt;

    Ok(())
}

#[derive(Accounts)]
pub struct BeginCashOut<'info> {
    /// The user cashing out. Signs the burn of their receipts, and pays the
    /// rent for the escrow and receipt, which settle_cash_out returns.
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.symbol.as_bytes()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        seeds = [WRAPPER_SEED, vault.key().as_ref(), wrapper_mint.key().as_ref()],
        bump = wrapper.bump,
    )]
    pub wrapper: Box<Account<'info, Wrapper>>,

    #[account(address = wrapper.mint)]
    pub wrapper_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = wrapper_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_wrapper_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Where the wrapper lands, for the user to sell from in the same
    /// transaction. The user's own account, because a route has to be signed
    /// by whoever owns what it sells.
    #[account(
        mut,
        associated_token::mint = wrapper_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_wrapper_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, address = vault.receipt_mint)]
    pub receipt_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = receipt_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_receipt_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// What the user is to be paid in. Their choice: they are the one being
    /// paid, and the vault holds none of it.
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Destination for the sale. Fresh every cash out, owned by the vault PDA
    /// so nothing but settle_cash_out can move what lands in it.
    #[account(
        init,
        payer = user,
        seeds = [CASH_OUT_ESCROW_SEED, user.key().as_ref(), vault.key().as_ref()],
        bump,
        token::mint = payment_mint,
        token::authority = vault,
        token::token_program = payment_token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = user,
        space = 8 + CashOutReceipt::INIT_SPACE,
        seeds = [CASH_OUT_SEED, user.key().as_ref(), vault.key().as_ref()],
        bump,
    )]
    pub cash_out_receipt: Box<Account<'info, CashOutReceipt>>,

    /// CHECK: address pinned to the instructions sysvar.
    #[account(address = INSTRUCTIONS_SYSVAR)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    /// Token-2022, for the wrapper and the receipt, as the vault records.
    #[account(address = vault.token_program @ ParitasError::TokenProgramMismatch)]
    pub token_program: Interface<'info, TokenInterface>,
    /// The payment mint's program, classic SPL for USDC.
    pub payment_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Last instruction of a cash out. Measures what the sale put in the escrow,
/// holds it to the user's minimum, pays the user and closes everything
/// begin_cash_out opened, returning the rent.
pub fn settle_cash_out(ctx: Context<SettleCashOut>) -> Result<()> {
    // Same two checks as settle_execution: exactly one pair in this
    // transaction, and this invocation is the top level settle the scan found.
    let scan = scan_pair_transaction(&ctx.accounts.instructions_sysvar, cash_out_pair())?;
    require!(
        scan.settle_index == scan.current_index,
        ParitasError::SettleCashOutNotTopLevel
    );

    // The begin the scan found has to be this receipt's. The receipt address
    // is a pure function of user and vault, so finding it in that
    // instruction's accounts identifies the cash out.
    let receipt_key = ctx.accounts.cash_out_receipt.key();
    require!(
        scan.begin.accounts.iter().any(|meta| meta.pubkey == receipt_key),
        ParitasError::MissingBeginCashOut
    );

    let received = ctx.accounts.escrow.amount;
    require!(received > 0, ParitasError::NothingReceived);
    require!(
        received >= ctx.accounts.cash_out_receipt.min_payment_out,
        ParitasError::CashOutBelowMinimum
    );

    let symbol_bytes = ctx.accounts.vault.symbol.as_bytes().to_vec();
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[u8]] = &[VAULT_SEED, &symbol_bytes, &[bump]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.payment_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.escrow.to_account_info(),
                mint: ctx.accounts.payment_mint.to_account_info(),
                to: ctx.accounts.user_payment_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[signer_seeds],
        ),
        received,
        ctx.accounts.payment_mint.decimals,
    )?;

    close_account(CpiContext::new_with_signer(
        ctx.accounts.payment_token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.user.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        &[signer_seeds],
    ))?;

    Ok(())
}

#[derive(Accounts)]
pub struct SettleCashOut<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, vault.symbol.as_bytes()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [CASH_OUT_SEED, user.key().as_ref(), vault.key().as_ref()],
        bump = cash_out_receipt.bump,
        has_one = user @ ParitasError::Unauthorized,
        has_one = vault @ ParitasError::VaultMismatch,
        close = user,
    )]
    pub cash_out_receipt: Box<Account<'info, CashOutReceipt>>,

    #[account(
        mut,
        address = cash_out_receipt.escrow @ ParitasError::ExecutionReceiptMismatch,
        token::mint = payment_mint,
        token::authority = vault,
        token::token_program = payment_token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(address = cash_out_receipt.payment_mint @ ParitasError::PaymentMintMismatch)]
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = payment_mint,
        token::authority = user,
        token::token_program = payment_token_program,
    )]
    pub user_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: address pinned to the instructions sysvar.
    #[account(address = INSTRUCTIONS_SYSVAR)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub payment_token_program: Interface<'info, TokenInterface>,
}
