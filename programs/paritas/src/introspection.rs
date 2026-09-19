// The instructions sysvar helpers moved out of solana-program into
// solana-instructions-sysvar, and the re-exports anchor-lang 0.32.1 gives us
// are marked deprecated. Taking the direct dependency would risk resolving a
// second copy of the crate with an incompatible AccountInfo, so the re-export
// is the right one to use and the allow is scoped to this file.
#![allow(deprecated)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
};
use anchor_lang::Discriminator;

use crate::error::ParitasError;

/// Address of the instructions sysvar, for the account constraint on any
/// instruction that introspects.
pub const INSTRUCTIONS_SYSVAR: Pubkey = INSTRUCTIONS_SYSVAR_ID;

/// Upper bound on how many instructions the scan will look at. A transaction
/// cannot hold anywhere near this many within the 1232 byte limit, but the
/// scan walks until the sysvar reports the end and a bound that is never hit
/// is cheaper than trusting that it always reports one. Reaching it is an
/// error, not a place to stop: stopping early would let a second
/// begin_execution hide past the cutoff.
const MAX_SCANNED_INSTRUCTIONS: usize = 64;

/// Which begin/settle pair a scan is looking for, and the errors that name
/// it. The buy (begin_execution, settle_execution) and the cash out
/// (begin_cash_out, settle_cash_out) are the same shape, a begin that opens an
/// escrow and a settle that measures and closes it, so they share one scan and
/// differ only in what they are called.
pub struct PairKind {
    pub begin: &'static [u8],
    pub settle: &'static [u8],
    pub missing_begin: ParitasError,
    pub duplicate_begin: ParitasError,
    pub missing_settle: ParitasError,
    pub duplicate_settle: ParitasError,
    pub order_invalid: ParitasError,
}

pub fn execution_pair() -> PairKind {
    PairKind {
        begin: crate::instruction::BeginExecution::DISCRIMINATOR,
        settle: crate::instruction::SettleExecution::DISCRIMINATOR,
        missing_begin: ParitasError::MissingBeginExecution,
        duplicate_begin: ParitasError::DuplicateBeginExecution,
        missing_settle: ParitasError::MissingSettleExecution,
        duplicate_settle: ParitasError::DuplicateSettleExecution,
        order_invalid: ParitasError::ExecutionOrderInvalid,
    }
}

pub fn cash_out_pair() -> PairKind {
    PairKind {
        begin: crate::instruction::BeginCashOut::DISCRIMINATOR,
        settle: crate::instruction::SettleCashOut::DISCRIMINATOR,
        missing_begin: ParitasError::MissingBeginCashOut,
        duplicate_begin: ParitasError::DuplicateBeginCashOut,
        missing_settle: ParitasError::MissingSettleCashOut,
        duplicate_settle: ParitasError::DuplicateSettleCashOut,
        order_invalid: ParitasError::CashOutOrderInvalid,
    }
}

/// What a scan of the current transaction found.
pub struct PairScan {
    /// Index of this transaction's only top level begin of the pair.
    pub begin_index: usize,
    /// Index of this transaction's only top level settle of the pair.
    pub settle_index: usize,
    /// Index of the instruction currently executing.
    pub current_index: usize,
    /// The deserialized begin, so the settle can confirm what it operated on.
    pub begin: Instruction,
}

/// The buy's scan, kept under its original name for the two instructions
/// that already call it.
pub fn scan_execution_transaction(instructions_sysvar: &AccountInfo) -> Result<PairScan> {
    scan_pair_transaction(instructions_sysvar, execution_pair())
}

/// Walks every top level instruction in the current transaction and requires
/// that the paritas instructions in it are exactly one begin of the given
/// pair followed by one settle of it, and nothing else of this program's.
///
/// The strictness is the point. An escrowed operation is only safe if what
/// surrounds it is knowable, and the cheapest way to know it is to refuse
/// anything that is not the documented shape. It also keeps the two pairs
/// apart: a buy and a cash out cannot share a transaction, because each scan
/// treats the other's instructions as unexpected.
///
/// Note what this does and does not see: the instructions sysvar lists top
/// level instructions only, never instructions reached by CPI. That cuts both
/// ways, and both are handled here. A paritas instruction smuggled in under a
/// CPI is invisible to this scan, so it cannot be counted, and any instruction
/// relying on this scan must also confirm that it is itself the top level
/// instruction at current_index. If it is not, it was reached by CPI and the
/// scan describes some other instruction's surroundings, not its own.
pub fn scan_pair_transaction(
    instructions_sysvar: &AccountInfo,
    kind: PairKind,
) -> Result<PairScan> {
    let current_index = load_current_index_checked(instructions_sysvar)? as usize;

    let mut begin: Option<(usize, Instruction)> = None;
    let mut settle_index: Option<usize> = None;

    for index in 0..=MAX_SCANNED_INSTRUCTIONS {
        let instruction = match load_instruction_at_checked(index, instructions_sysvar) {
            Ok(instruction) => instruction,
            // The sysvar reports out of bounds as an error, which is how the
            // end of the transaction announces itself.
            Err(_) => {
                let (begin_index, begin) = begin.ok_or(error!(kind.missing_begin))?;
                let settle_index = settle_index.ok_or(error!(kind.missing_settle))?;
                require!(begin_index < settle_index, kind.order_invalid);
                return Ok(PairScan {
                    begin_index,
                    settle_index,
                    current_index,
                    begin,
                });
            }
        };

        if index == MAX_SCANNED_INSTRUCTIONS {
            return err!(ParitasError::TransactionTooLong);
        }

        if instruction.program_id != crate::ID {
            continue;
        }

        let discriminator = instruction
            .data
            .get(..8)
            .ok_or(error!(ParitasError::UnexpectedParitasInstruction))?;

        if discriminator == kind.begin {
            if begin.is_some() {
                return Err(error!(kind.duplicate_begin));
            }
            begin = Some((index, instruction));
        } else if discriminator == kind.settle {
            if settle_index.is_some() {
                return Err(error!(kind.duplicate_settle));
            }
            settle_index = Some(index);
        } else {
            // Any other paritas instruction alongside an escrowed operation
            // could move vault tokens while it is measuring them.
            return err!(ParitasError::UnexpectedParitasInstruction);
        }
    }

    err!(ParitasError::TransactionTooLong)
}
