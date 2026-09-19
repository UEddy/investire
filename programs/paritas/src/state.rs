use anchor_lang::prelude::*;

pub const PAIR_SEED: &[u8] = b"pair";

/// Maximum fee, in basis points, that register_pair will accept.
pub const MAX_FEE_BPS: u16 = 1_000; // 10%

/// An explicit allowlist entry for one equity-unit-equivalent pair of
/// Token-2022 mints. mint_a is always the lexicographically smaller of the
/// two mint pubkeys; mint_b the larger. This ordering, not symbol matching,
/// is what makes the pair PDA address deterministic and collision free.
#[account]
#[derive(InitSpace)]
pub struct Pair {
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub decimals_a: u8,
    pub decimals_b: u8,
    pub fee_bps: u16,
    pub authority: Pubkey,
    pub bump: u8,
}

pub const VAULT_SEED: &[u8] = b"vault";
pub const RECEIPT_MINT_SEED: &[u8] = b"receipt";
pub const WRAPPER_SEED: &[u8] = b"wrapper";

/// Maximum length, in bytes, of a Vault's symbol label.
pub const MAX_SYMBOL_LEN: usize = 16;

/// Decimal precision of every Vault's receipt mint. This is deliberately the
/// equity unit scale itself, not an independent choice: one receipt raw unit
/// must equal exactly one equity unit, or deposit would mint a quantity in
/// one scale while the mint denominated it in another.
pub const RECEIPT_DECIMALS: u8 = crate::multiplier::EQUITY_UNIT_DECIMALS;

/// A vault that holds one or more Token-2022 wrappers of the same underlying
/// equity, and issues a single receipt token denominated in equity units
/// rather than in any one wrapper's raw amount. The symbol is an operator
/// supplied label (like "NVDA"); it is not verified against any on-chain
/// source of truth, since symbol resolution is unsafe, the same reasoning
/// that makes register_pair an explicit allowlist rather than a symbol
/// lookup. Trust comes from which wrapper mints add_wrapper has allowed in,
/// not from this label.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    #[max_len(MAX_SYMBOL_LEN)]
    pub symbol: String,
    pub receipt_mint: Pubkey,
    /// The token program the receipt mint was created under, and the one every
    /// wrapper added to this vault must also be owned by.
    ///
    /// deposit, withdraw and settle_execution all take a single token program
    /// account and use it for both the wrapper leg and the receipt leg, so a
    /// vault holding Token-2022 wrappers against a classic SPL receipt mint
    /// could not be transacted at all. Rather than leave that as an invariant
    /// an operator has to know, it is recorded here at creation and enforced
    /// by add_wrapper, which is the only place a mismatch can be introduced.
    pub token_program: Pubkey,
    pub authority: Pubkey,
    /// Sum of equity units represented by receipt tokens outstanding, at
    /// RECEIPT_DECIMALS fixed point. Kept in lockstep with the receipt
    /// mint's supply: deposit increments it by exactly what it mints,
    /// withdraw decrements it by exactly what it burns.
    pub total_equity_units: u128,
    /// The permissionless caller's cut of one execution, in basis points of
    /// the schedule amount, and the least they may be paid in raw units of the
    /// payment mint whatever the basis points work out to.
    ///
    /// These sit on the Vault, not in the program, because the right number is
    /// a function of what a transaction costs to land, and that moves with
    /// network conditions rather than with anything the program knows. A
    /// quarter of a percent of a five dollar buy is about a cent, which does
    /// not cover a priority fee on a busy slot, and a keeper that cannot cover
    /// its costs simply stops running schedules. The vault authority retunes
    /// both with set_keeper_fee; neither needs a program upgrade.
    ///
    /// What the authority cannot do is raise the real cost past
    /// MAX_KEEPER_FEE_BPS, which is enforced in the program on every
    /// execution. The money being paid out belongs to schedule owners who
    /// never agreed to a fee change, so the ceiling is not the authority's to
    /// move.
    pub keeper_fee_bps: u16,
    pub keeper_fee_min: u64,
    pub bump: u8,
}

/// Hard ceiling on what one execution can pay its caller, in basis points of
/// the schedule amount. Bounds both the configured basis points and the
/// configured minimum, so a misconfigured or hostile vault authority cannot
/// turn the keeper fee into a drain on the schedules that trusted the vault.
pub const MAX_KEEPER_FEE_BPS: u16 = 200; // 2%

/// An explicit allowlist entry for one wrapper mint accepted by a Vault.
/// Its existence at the PDA derived from (vault, mint) is what deposit and
/// withdraw rely on to reject unregistered mints: an uninitialized account
/// at that address fails to deserialize, the same allowlist mechanism
/// register_pair's Pair PDA provides for swap.
#[account]
#[derive(InitSpace)]
pub struct Wrapper {
    pub mint: Pubkey,
    pub decimals: u8,
    pub bump: u8,
}

pub const SCHEDULE_SEED: &[u8] = b"schedule";
pub const EXECUTION_SEED: &[u8] = b"execution";
pub const EXECUTION_ESCROW_SEED: &[u8] = b"escrow";

/// Shortest cadence create_schedule will accept. A savings plan is weekly or
/// monthly; anything under an hour is either a mistake or an attempt to let a
/// permissionless keeper drain the owner's delegated allowance quickly.
pub const MIN_CADENCE_SECONDS: i64 = 3_600;

/// Widest tolerance create_schedule will accept on the ratcheting floor. A
/// tolerance at this ceiling still rejects a caller who delivers less than
/// half of what the previous execution did.
pub const MAX_FLOOR_TOLERANCE_BPS: u16 = 5_000; // 50%

/// A recurring buy. The owner sets it once and it runs until cancelled.
///
/// Balances here are equity units, not raw wrapper amounts, for the same
/// reason the Vault's are: a schedule that buys NVDAx one week and NVDAon the
/// next has bought the same underlying both times, and only the equity unit
/// figure says so.
///
/// payment_mint is not in the original state list but has to be stored. The
/// mint being pulled from the owner's delegated allowance decides what the
/// owner actually pays; if settle_execution took it from an account the
/// untrusted caller passes in, the caller could point every execution at a
/// worthless mint the owner happens to have delegated, or at a mint the owner
/// delegated for some other purpose entirely. It is pinned at create time,
/// when the owner signs, and checked on every execution.
///
/// min_equity_units is likewise an addition. The spec has settle_execution
/// enforce a minimum passed by the caller, but the caller is untrusted and
/// will pass zero: a floor that the caller chooses protects nobody. This is
/// the owner's floor, and the caller's value can only tighten it, never
/// loosen it.
///
/// It ratchets. A floor fixed at creation is wrong within weeks, because the
/// number of shares a fixed sum buys falls as the underlying rises, so a
/// static floor eventually rejects every honest execution and the savings plan
/// silently stops. After each execution the floor is reset to what that
/// execution actually delivered, discounted by floor_tolerance_bps, so it
/// tracks the price instead of drifting away from it.
///
/// Be clear about what the ratchet does and does not buy. It bounds how much
/// one execution can be shorted: at most floor_tolerance_bps below the last
/// real result. It does not bound the total, because a caller who shorts every
/// execution by the full tolerance walks the floor down geometrically. There
/// is no oracle here to anchor against, so no self maintaining floor can stop
/// that. What stops it is that initial_min_equity_units is kept alongside, and
/// the gap between the two is plainly readable by the owner and by anything
/// watching the vault.
#[account]
#[derive(InitSpace)]
pub struct Schedule {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub payment_mint: Pubkey,
    /// The owner's token account the executions debit. Pinned at create time
    /// alongside the mint: the owner may hold several accounts of the same
    /// mint, and which one funds the plan is the owner's decision, not the
    /// decision of whoever happens to run an execution.
    pub owner_payment_account: Pubkey,
    pub schedule_index: u8,
    pub amount_usdc: u64,
    pub cadence_seconds: i64,
    pub next_due_ts: i64,
    /// The live floor. Starts at the owner's signed value and is reset by each
    /// execution to that execution's realised equity units, less the
    /// tolerance.
    pub min_equity_units: u64,
    /// The owner's signed value, never written again. Kept so the ratchet's
    /// drift from what the owner originally agreed to stays visible.
    pub initial_min_equity_units: u64,
    /// How far below the previous execution's realised equity units the next
    /// one may land. Wide enough to absorb an ordinary move in the underlying
    /// between two runs, narrow enough that a short delivery is rejected.
    pub floor_tolerance_bps: u16,
    pub executions: u64,
    pub total_usdc_spent: u64,
    pub total_equity_units: u128,
    pub active: bool,
    pub bump: u8,
}

/// The record begin_execution writes and settle_execution consumes, at the
/// PDA derived from the schedule. It exists for exactly the span of one
/// transaction: begin_execution creates it, settle_execution closes it, and
/// begin_execution refuses to run unless a settle_execution for the same
/// schedule is present later in the same transaction, so it can never be left
/// behind for a later transaction to reuse.
///
/// Everything in it was written by this program, which is what makes it worth
/// more than the caller supplied accounts settle_execution is otherwise
/// handed. Instruction introspection proves it is fresh; these fields say
/// what the fresh begin_execution actually did.
#[account]
#[derive(InitSpace)]
pub struct ExecutionReceipt {
    pub schedule: Pubkey,
    pub caller: Pubkey,
    pub wrapper_mint: Pubkey,
    pub escrow: Pubkey,
    /// Where settle_execution sends the keeper fee. Recorded because it is the
    /// one payment account the schedule does not pin: the owner's is fixed at
    /// create time, but the caller's is whatever the caller passed to
    /// begin_execution, and the fee has to land in that same account.
    pub caller_payment_account: Pubkey,
    /// Raw payment mint units moved out of the owner's account by
    /// begin_execution, net of the keeper fee settle_execution still owes.
    pub debited_usdc: u64,
    pub keeper_fee: u64,
    /// The schedule's next_due_ts as begin_execution saw it. settle_execution
    /// requires it to be unchanged, so a single due date can only be consumed
    /// by the begin_execution that opened it.
    pub due_ts: i64,
    pub bump: u8,
}

pub const CASH_OUT_SEED: &[u8] = b"cash_out";
pub const CASH_OUT_ESCROW_SEED: &[u8] = b"cash_out_escrow";

/// The record begin_cash_out writes and settle_cash_out consumes, for exactly
/// the span of one transaction, like ExecutionReceipt.
///
/// The difference from a buy is who is being protected. In a buy the caller
/// is an untrusted third party spending the owner's delegated money, so the
/// floor has to be the owner's, never the caller's. In a cash out the signer
/// is the user being paid: the vault's exposure ends at begin_cash_out, where
/// receipts are burned against wrapper paid out exactly as in withdraw. So
/// min_payment_out is the user's own figure and binding them to it is correct;
/// the escrow and the settle protect the user from a bad route or a short
/// fill, not the vault from the user.
#[account]
#[derive(InitSpace)]
pub struct CashOutReceipt {
    pub user: Pubkey,
    pub vault: Pubkey,
    pub wrapper_mint: Pubkey,
    /// Raw wrapper paid out to the user to sell.
    pub wrapper_paid: u64,
    /// The mint the user asked to be paid in. The user's choice, since the
    /// user is the one being paid; the vault holds none of it.
    pub payment_mint: Pubkey,
    pub escrow: Pubkey,
    pub min_payment_out: u64,
    pub bump: u8,
}
