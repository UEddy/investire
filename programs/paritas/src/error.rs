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
}
