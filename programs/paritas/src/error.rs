use anchor_lang::prelude::*;

#[error_code]
pub enum ParitasError {
    #[msg("mint account data could not be parsed")]
    InvalidMintData,
    #[msg("mint is missing the ScaledUiAmountConfig extension")]
    MissingScaledUiAmountExtension,
    #[msg("mint multiplier is not a valid positive finite value")]
    InvalidMultiplier,
    #[msg("fixed point math overflowed")]
    MathOverflow,
    #[msg("mint_a must be lexicographically smaller than mint_b")]
    MintsNotSorted,
    #[msg("fee exceeds the maximum allowed basis points")]
    FeeTooHigh,
    #[msg("swap output is below the caller's minimum")]
    SlippageExceeded,
    #[msg("swap amount must be greater than zero")]
    ZeroAmount,
    #[msg("vault symbol exceeds the maximum allowed length")]
    SymbolTooLong,
    #[msg("vault symbol must not be empty")]
    EmptySymbol,
    #[msg("only the vault's authority may perform this action")]
    Unauthorized,
    #[msg("the vault's balance of that wrapper is insufficient for this withdrawal")]
    InsufficientVaultBalance,
    #[msg("mint is not one of the two mints registered on this pair")]
    MintNotInPair,
    #[msg("the pool's balance of that mint is insufficient for this withdrawal")]
    InsufficientPoolBalance,
    #[msg("cadence is shorter than the minimum allowed interval")]
    CadenceTooShort,
    #[msg("schedule amount is below the dust floor for this payment mint")]
    AmountBelowDustFloor,
    #[msg("schedule is not active")]
    ScheduleInactive,
    #[msg("schedule is not due yet")]
    ScheduleNotDue,
    #[msg("token account does not hold the schedule's payment mint")]
    PaymentMintMismatch,
    #[msg("token account is not owned by the expected authority")]
    TokenAccountOwnerMismatch,
    #[msg("schedule does not belong to this vault")]
    VaultMismatch,
    #[msg("keeper fee is not smaller than the schedule amount")]
    FeeExceedsAmount,
    #[msg("execution receipt does not match this execution")]
    ExecutionReceiptMismatch,
    #[msg("no begin_execution for this schedule in this transaction")]
    MissingBeginExecution,
    #[msg("more than one begin_execution in this transaction")]
    DuplicateBeginExecution,
    #[msg("no settle_execution in this transaction")]
    MissingSettleExecution,
    #[msg("more than one settle_execution in this transaction")]
    DuplicateSettleExecution,
    #[msg("begin_execution must come before settle_execution")]
    ExecutionOrderInvalid,
    #[msg("settle_execution must be a top level instruction, not a CPI")]
    SettleNotTopLevel,
    #[msg("begin_execution must be a top level instruction, not a CPI")]
    BeginNotTopLevel,
    #[msg("this transaction carries a paritas instruction that is not part of the execution")]
    UnexpectedParitasInstruction,
    #[msg("transaction has more instructions than introspection will scan")]
    TransactionTooLong,
    #[msg("the swap delivered nothing to the execution escrow")]
    NothingReceived,
    #[msg("equity units received are below the required minimum")]
    MinEquityUnitsNotMet,
    #[msg("mint is not owned by the token program this vault was created under")]
    TokenProgramMismatch,
    #[msg("floor tolerance exceeds the maximum allowed basis points")]
    FloorToleranceTooWide,
    #[msg("schedule amount is too small to pay this vault's minimum keeper fee")]
    AmountCannotCoverKeeperFee,
    // Appended, never inserted: error codes are 6000 plus position, and
    // clients match on them.
    #[msg("no begin_cash_out in this transaction")]
    MissingBeginCashOut,
    #[msg("more than one begin_cash_out in this transaction")]
    DuplicateBeginCashOut,
    #[msg("no settle_cash_out in this transaction")]
    MissingSettleCashOut,
    #[msg("more than one settle_cash_out in this transaction")]
    DuplicateSettleCashOut,
    #[msg("begin_cash_out must come before settle_cash_out")]
    CashOutOrderInvalid,
    #[msg("begin_cash_out must be a top level instruction, not a CPI")]
    BeginCashOutNotTopLevel,
    #[msg("settle_cash_out must be a top level instruction, not a CPI")]
    SettleCashOutNotTopLevel,
    #[msg("the cash out delivered less than the minimum the user signed for")]
    CashOutBelowMinimum,
}
