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

impl Pair {
    pub fn sorted(a: Pubkey, b: Pubkey) -> (Pubkey, Pubkey) {
        if a < b {
            (a, b)
        } else {
            (b, a)
        }
    }
}
