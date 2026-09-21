use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::pubkey::Pubkey;
use anchor_spl::token_interface::Mint;

use crate::error::ParitasError;
use crate::state::{Vault, VAULT_SEED};

/// The Metaplex Token Metadata program, pinned.
///
/// This constant is the whole security model of this instruction, so it is
/// worth being explicit about why. The vault PDA is the mint authority of the
/// receipt mint and the authority on every vault token account, which is to
/// say it is the signature that can move the wrappers this vault holds. Here
/// that signature is produced by invoke_signed, and invoke_signed will sign
/// whatever instruction it is handed, for whatever program that instruction
/// names.
///
/// So if the program being called were read from an account the caller passed,
/// the caller could pass their own program, and this instruction would hand
/// them the vault's signature on an instruction of their choosing. A
/// transfer_checked draining the vault's wrapper account is an instruction of
/// their choosing. That is not a subtle failure, it is total, and it is why
/// the address is written here rather than taken from the transaction, and why
/// the account below carries an address constraint against it.
///
/// Verified deployed and executable on devnet and mainnet at this address.
pub const METADATA_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/// Metaplex's seed prefix for a metadata account. Its PDA is
/// ["metadata", metadata program id, mint].
const METADATA_SEED: &[u8] = b"metadata";

/// CreateMetadataAccountV3, as a single byte. Taken from
/// mpl-token-metadata 5.1.0,
/// src/generated/instructions/create_metadata_account_v3.rs, where
/// CreateMetadataAccountV3InstructionData::new sets discriminator: 33.
const CREATE_METADATA_ACCOUNT_V3: u8 = 33;

/// Metaplex's own limits on the three string fields, from
/// mpl-token-metadata 5.1.0 src/lib.rs. Checked here so an over long field is
/// a named refusal rather than a failure inside the CPI.
const MAX_NAME_LEN: usize = 32;
const MAX_SYMBOL_LEN: usize = 10;
const MAX_URI_LEN: usize = 200;

/// Gives a vault's receipt mint a Metaplex metadata account, so that wallets
/// show a saver's shares as a named token rather than hiding them or calling
/// them Unknown.
///
/// Why Metaplex and not the Token-2022 metadata extension: the receipt mints
/// were created at 82 bytes with no extension region at all. MetadataPointer
/// is a fixed length extension, which has to be initialised before
/// InitializeMint, and Token-2022's Reallocate applies to token accounts and
/// not to mints, so there is no way to add one to a mint that already exists.
/// The mints are also PDAs at ["receipt", vault], where the vault is a PDA at
/// ["vault", symbol], so both addresses are already taken and, with no
/// MintCloseAuthority, cannot be closed and remade. Recreating them means a
/// new symbol, a new vault, and every existing saver's balance stranded in the
/// old one. A Metaplex metadata account needs nothing of the mint and strands
/// nobody.
///
/// Three things make the vault's signature safe to use here:
///
/// 1. The program called is METADATA_PROGRAM_ID, a constant, and the account
///    passed for it carries an address constraint against that constant. The
///    caller cannot substitute a program.
/// 2. The vault authority signs. This is not a permissionless instruction.
/// 3. The instruction handed to invoke_signed is built in this function, from
///    the constant discriminator above and accounts that are all either
///    constants, PDAs this program derives, or pinned to the vault. The caller
///    chooses the three display strings and nothing else. There is no code
///    path here that signs an instruction this function did not construct.
///
/// The three strings are the only caller input, and they are only ever data
/// inside a CreateMetadataAccountV3 call to Metaplex about this vault's own
/// receipt mint. They cannot change which program is called, which instruction
/// is run, or which accounts it touches.
///
/// is_mutable is true: the update authority stays with the vault, so a name or
/// an off chain uri can be corrected later without any of this being redone.
pub fn init_receipt_metadata(
    ctx: Context<InitReceiptMetadata>,
    name: String,
    symbol: String,
    uri: String,
) -> Result<()> {
    require!(name.len() <= MAX_NAME_LEN, ParitasError::MetadataNameTooLong);
    require!(
        symbol.len() <= MAX_SYMBOL_LEN,
        ParitasError::MetadataSymbolTooLong
    );
    require!(uri.len() <= MAX_URI_LEN, ParitasError::MetadataUriTooLong);

    let vault = &ctx.accounts.vault;
    let vault_key = vault.key();

    // Built here, never passed in. Every account is fixed: the metadata PDA is
    // derived and constrained above, the mint is pinned to vault.receipt_mint,
    // the two authority slots are the vault itself, and the payer is the
    // signing vault authority.
    let accounts = vec![
        AccountMeta::new(ctx.accounts.metadata.key(), false),
        AccountMeta::new_readonly(ctx.accounts.receipt_mint.key(), false),
        // Mint authority, and the reason this instruction exists: the vault is
        // the receipt mint's authority, and Metaplex requires its signature.
        AccountMeta::new_readonly(vault_key, true),
        AccountMeta::new(ctx.accounts.authority.key(), true),
        // Update authority. Signed by the vault as well, which costs nothing
        // since the vault is already signing, and leaves the metadata
        // updatable by this program later.
        AccountMeta::new_readonly(vault_key, true),
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
    ];

    let instruction = Instruction {
        program_id: METADATA_PROGRAM_ID,
        accounts,
        data: create_metadata_data(&name, &symbol, &uri),
    };

    let symbol_bytes = vault.symbol.as_bytes().to_vec();
    let bump = vault.bump;
    let signer_seeds: &[&[u8]] = &[VAULT_SEED, &symbol_bytes, &[bump]];

    invoke_signed(
        &instruction,
        &[
            ctx.accounts.metadata.to_account_info(),
            ctx.accounts.receipt_mint.to_account_info(),
            vault.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.metadata_program.to_account_info(),
        ],
        &[signer_seeds],
    )?;

    Ok(())
}

/// The instruction data for CreateMetadataAccountV3, borsh encoded by hand.
///
/// Encoded here rather than by depending on mpl-token-metadata, which would
/// pull a large tree into a build that is already pinned to a specific
/// platform-tools version for dependency reasons. The layout is small, fixed,
/// and taken from mpl-token-metadata 5.1.0:
///
///   u8   discriminator = 33
///   DataV2 { name: String, symbol: String, uri: String,
///            seller_fee_basis_points: u16,
///            creators: Option<Vec<Creator>>,
///            collection: Option<Collection>,
///            uses: Option<Uses> }
///   bool is_mutable
///   Option<CollectionDetails> collection_details
///
/// Borsh encodes a String as a u32 little endian length followed by its bytes,
/// and an Option as a single 0 or 1 tag followed by the value when present.
/// The three Options in DataV2 and the trailing one are all None here: this is
/// a fungible receipt token, with no creators, no collection and no uses.
///
/// encodes_the_documented_layout below asserts these bytes against the layout
/// field by field, so a mistake here fails the test rather than the CPI.
fn create_metadata_data(name: &str, symbol: &str, uri: &str) -> Vec<u8> {
    let mut data = Vec::with_capacity(64 + name.len() + symbol.len() + uri.len());

    data.push(CREATE_METADATA_ACCOUNT_V3);

    for field in [name, symbol, uri] {
        data.extend_from_slice(&(field.len() as u32).to_le_bytes());
        data.extend_from_slice(field.as_bytes());
    }

    // seller_fee_basis_points: nothing is being sold, and a royalty on a
    // savings receipt would be meaningless.
    data.extend_from_slice(&0u16.to_le_bytes());

    data.push(0); // creators: None
    data.push(0); // collection: None
    data.push(0); // uses: None
    data.push(1); // is_mutable: true
    data.push(0); // collection_details: None

    data
}

#[derive(Accounts)]
pub struct InitReceiptMetadata<'info> {
    #[account(
        has_one = authority @ ParitasError::Unauthorized,
        seeds = [VAULT_SEED, vault.symbol.as_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    /// The vault authority, which must sign. Same gate as add_wrapper and
    /// set_keeper_fee, and pays the rent for the metadata account.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Pinned to this vault's own receipt mint. Naming any other mint, even
    /// another Paritas vault's, is rejected here rather than relying on
    /// Metaplex to notice that the signing authority does not match.
    #[account(address = vault.receipt_mint)]
    pub receipt_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: created by the CPI, so it is unallocated when this runs and
    /// cannot be deserialised. It is not unchecked in the sense that matters:
    /// the seeds constraint derives Metaplex's own PDA for receipt_mint, under
    /// the pinned program below, so only the one correct address is accepted.
    #[account(
        mut,
        seeds = [METADATA_SEED, METADATA_PROGRAM_ID.as_ref(), receipt_mint.key().as_ref()],
        bump,
        seeds::program = METADATA_PROGRAM_ID,
    )]
    pub metadata: UncheckedAccount<'info>,

    /// CHECK: pinned by address to the constant above, which is what stops
    /// this instruction from handing the vault's signature to a program the
    /// caller chose. See METADATA_PROGRAM_ID.
    #[account(
        address = METADATA_PROGRAM_ID @ ParitasError::MetadataProgramMismatch,
        constraint = metadata_program.executable @ ParitasError::MetadataProgramMismatch,
    )]
    pub metadata_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Walks the encoding field by field against the layout in the doc comment
    /// on create_metadata_data. The point is that a change to the encoder has
    /// to be a deliberate change to this test too, rather than something that
    /// only shows up as a failed CPI on devnet.
    #[test]
    fn encodes_the_documented_layout() {
        let data = create_metadata_data("Investire NVIDIA", "ivNVDA", "https://x.test/n.json");

        let mut at = 0usize;
        assert_eq!(data[at], 33, "discriminator");
        at += 1;

        for expected in ["Investire NVIDIA", "ivNVDA", "https://x.test/n.json"] {
            let len =
                u32::from_le_bytes(data[at..at + 4].try_into().unwrap()) as usize;
            assert_eq!(len, expected.len(), "length prefix for {expected}");
            at += 4;
            assert_eq!(&data[at..at + len], expected.as_bytes(), "bytes of {expected}");
            at += len;
        }

        assert_eq!(&data[at..at + 2], &[0, 0], "seller_fee_basis_points");
        at += 2;

        assert_eq!(data[at], 0, "creators None");
        assert_eq!(data[at + 1], 0, "collection None");
        assert_eq!(data[at + 2], 0, "uses None");
        assert_eq!(data[at + 3], 1, "is_mutable true");
        assert_eq!(data[at + 4], 0, "collection_details None");
        assert_eq!(at + 5, data.len(), "no trailing bytes");
    }

    /// The empty strings case, which is the one where a length prefix that was
    /// written as anything other than four bytes would still look plausible.
    #[test]
    fn encodes_empty_strings_with_four_byte_prefixes() {
        let data = create_metadata_data("", "", "");
        // 1 discriminator + 4 + 4 + 4 length prefixes + 2 seller fee
        // + creators, collection, uses, is_mutable, collection_details.
        assert_eq!(data.len(), 20);
        assert_eq!(
            data,
            vec![33, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
        );
    }

    /// The pinned program id, spelled out independently of the constant so
    /// that editing the constant cannot quietly retarget every CPI.
    #[test]
    fn metadata_program_id_is_the_metaplex_one() {
        assert_eq!(
            METADATA_PROGRAM_ID.to_string(),
            "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
        );
    }
}
