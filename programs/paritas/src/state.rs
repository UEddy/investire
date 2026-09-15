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
    pub authority: Pubkey,
    /// Sum of equity units represented by receipt tokens outstanding, at
    /// RECEIPT_DECIMALS fixed point. Kept in lockstep with the receipt
    /// mint's supply: deposit increments it by exactly what it mints,
    /// withdraw decrements it by exactly what it burns.
    pub total_equity_units: u128,
    pub bump: u8,
}

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
