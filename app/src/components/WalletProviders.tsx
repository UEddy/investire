"use client";

import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { RPC_URL } from "@/lib/config";

import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * No adapter packages. Phantom, Solflare, Backpack and the rest register
 * themselves through the Wallet Standard, which wallet-adapter discovers on
 * its own, so an empty list finds every wallet a person actually has
 * installed. Naming them explicitly pulls in the whole adapter tree,
 * WalletConnect and Ledger and several chains this app has no use for, and
 * ships it to a phone.
 */
export function WalletProviders({ children }: { children: React.ReactNode }) {
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
