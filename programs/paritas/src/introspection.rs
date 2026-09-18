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

/// What a scan of the current transaction found.
pub struct ExecutionScan {
    /// Index of this transaction's only top level paritas begin_execution.
    pub begin_index: usize,
    /// Index of this transaction's only top level paritas settle_execution.
    pub settle_index: usize,
    /// Index of the instruction currently executing.
    pub current_index: usize,
    /// The deserialized begin_execution, so the caller can confirm which
    /// schedule it operated on.
    pub begin: Instruction,
}

/// Walks every top level instruction in the current transaction and requires
/// that the paritas instructions in it are exactly one begin_execution
/// followed by one settle_execution.
///
/// The strictness is the point. A permissionless execution is only safe if
/// what surrounds it is knowable, and the cheapest way to know it is to refuse
/// anything that is not the documented three instruction shape. It costs the
/// keeper the ability to batch several schedules into one transaction, which
/// is a fair price for a rule that can be read in one sitting.
///
/// Note what this does and does not see: the instructions sysvar lists top
/// level instructions only, never instructions reached by CPI. That cuts both
/// ways, and both are handled here. A paritas instruction smuggled in under a
/// CPI is invisible to this scan, so it cannot be counted, and any instruction
/// relying on this scan must also confirm that it is itself the top level
/// instruction at current_index. If it is not, it was reached by CPI and the
/// scan describes some other instruction's surroundings, not its own.
pub fn scan_execution_transaction(instructions_sysvar: &AccountInfo) -> Result<ExecutionScan> {
    let current_index = load_current_index_checked(instructions_sysvar)? as usize;

    let mut begin: Option<(usize, Instruction)> = None;
    let mut settle_index: Option<usize> = None;

    for index in 0..=MAX_SCANNED_INSTRUCTIONS {
        let instruction = match load_instruction_at_checked(index, instructions_sysvar) {
            Ok(instruction) => instruction,
            // The sysvar reports out of bounds as an error, which is how the
            // end of the transaction announces itself.
            Err(_) => {
                return finish(begin, settle_index, current_index);
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

        if discriminator == crate::instruction::BeginExecution::DISCRIMINATOR {
            require!(begin.is_none(), ParitasError::DuplicateBeginExecution);
            begin = Some((index, instruction));
        } else if discriminator == crate::instruction::SettleExecution::DISCRIMINATOR {
            require!(settle_index.is_none(), ParitasError::DuplicateSettleExecution);
            settle_index = Some(index);
        } else {
            // Any other paritas instruction alongside an execution could move
            // vault tokens while the execution is measuring them.
            return err!(ParitasError::UnexpectedParitasInstruction);
        }
    }

    err!(ParitasError::TransactionTooLong)
}

fn finish(
    begin: Option<(usize, Instruction)>,
    settle_index: Option<usize>,
    current_index: usize,
) -> Result<ExecutionScan> {
    let (begin_index, begin) = begin.ok_or(error!(ParitasError::MissingBeginExecution))?;
    let settle_index = settle_index.ok_or(error!(ParitasError::MissingSettleExecution))?;
    require!(
        begin_index < settle_index,
        ParitasError::ExecutionOrderInvalid
    );

    Ok(ExecutionScan {
        begin_index,
        settle_index,
        current_index,
        begin,
    })
}
