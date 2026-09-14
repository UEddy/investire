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
    #[msg("the two mints in a pair must be different")]
    DuplicateMint,
    #[msg("fee exceeds the maximum allowed basis points")]
    FeeTooHigh,
    #[msg("swap output is below the caller's minimum")]
    SlippageExceeded,
    #[msg("swap amount must be greater than zero")]
    ZeroAmount,
}
