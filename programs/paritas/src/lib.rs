use anchor_lang::prelude::*;

declare_id!("5QkWw7s4dQwAhNZQoKGDTrb6xqcZnMi8XPA7tAkD29LV");

#[program]
pub mod paritas {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
