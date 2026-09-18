import book from "@/config/devnet.json";
import idl from "@/config/paritas-idl.json";

/**
 * The address book written by scripts/setup-devnet.ts. Every address the app
 * uses comes from here. Nothing on chain is named anywhere else in this
 * codebase, so pointing the app at a different deployment is a matter of
 * shipping a different devnet.json.
 */
export interface Wrapper {
  label: string;
  mint: string;
  decimals: number;
  wrapper: string;
  vaultTokenAccount: string;
  ownerTokenAccount: string;
}

export interface AddressBook {
  cluster: string;
  rpcUrl: string;
  programId: string;
  tokenProgram2022: string;
  tokenProgramClassic: string;
  payment: { label: string; mint: string; decimals: number; tokenProgram: string };
  vault: {
    symbol: string;
    displayName: string;
    address: string;
    receiptMint: string;
    receiptDecimals: number;
    tokenProgram: string;
    keeperFeeBps: number;
    keeperFeeMin: string;
  };
  wrappers: Wrapper[];
  owner: { address: string; paymentAccount: string; receiptAccount: string };
  seeds: Record<string, string>;
}

export const ADDRESS_BOOK = book as AddressBook;
export const PARITAS_IDL = idl;

/**
 * The RPC the app talks to. The address book records which endpoint the
 * environment was built against; an override lets a deployment point at a
 * paid endpoint without rebuilding the address book.
 */
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? ADDRESS_BOOK.rpcUrl;

/** Amounts offered on the create screen, in whole units of the payment mint. */
export const AMOUNT_PRESETS = [5, 10, 25];

export const WEEK_SECONDS = 7 * 24 * 60 * 60;
