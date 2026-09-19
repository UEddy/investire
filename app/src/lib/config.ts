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
 * The RPC endpoint the browser should talk to.
 *
 * This is a function and not a module level constant on purpose. As a constant
 * it was evaluated at import time, which during `next build` means while the
 * page is being statically generated on the server, with no window and no
 * browser env. ConnectionProvider then received whatever that produced and
 * web3.js rejected it: "Endpoint URL must start with http: or https:". Every
 * route inherits the root layout, so even /_not-found failed.
 *
 * The rule this encodes: nothing on the server ever needs a Connection. The
 * browser reaches the chain through this app's own /api/rpc proxy, and the
 * proxy itself calls the upstream with plain fetch, not with a Connection. So
 * asking for an endpoint outside the browser is a mistake, and it throws
 * rather than inventing a placeholder that would paper over it.
 *
 * NEXT_PUBLIC_RPC_URL overrides the proxy with a direct connection, and is
 * correct only for an endpoint with no key in it: anything with that prefix is
 * compiled into the bundle and readable by every visitor.
 */
export function resolveRpcEndpoint(): string {
  const direct = process.env.NEXT_PUBLIC_RPC_URL;
  if (direct) {
    if (!/^https?:\/\//.test(direct)) {
      throw new Error(
        `NEXT_PUBLIC_RPC_URL must be an absolute http(s) url, got "${direct}"`,
      );
    }
    return direct;
  }

  if (typeof window === "undefined") {
    throw new Error(
      "resolveRpcEndpoint was called on the server. Nothing server side in " +
        "this app should construct a web3.js Connection: the browser uses the " +
        "/api/rpc proxy, and the proxy calls upstream with fetch.",
    );
  }

  // Absolute, because web3.js parses the endpoint as a URL and a bare
  // "/api/rpc" is not one.
  return `${window.location.origin}/api/rpc`;
}

/** Amounts offered on the create screen, in whole units of the payment mint. */
export const AMOUNT_PRESETS = [5, 10, 25];

export const WEEK_SECONDS = 7 * 24 * 60 * 60;
