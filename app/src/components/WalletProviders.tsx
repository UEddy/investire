"use client";

import { useEffect, useState } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { resolveRpcEndpoint } from "@/lib/config";

// The picker's styles are this app's own. The library's stylesheet fetches a
// font from Google on every page load; see wallet-picker.css.
import "./wallet-picker.css";

/**
 * Wallet and connection context, mounted client side only.
 *
 * The endpoint is resolved in an effect rather than during render because
 * render also happens on the server, while Next statically generates the page.
 * There is no window there, and a web3.js Connection built without one throws
 * "Endpoint URL must start with http: or https:", which failed the build on
 * every route including /_not-found, since they all inherit the root layout.
 *
 * So no Connection exists until the browser has one to give. Until then this
 * renders the same quiet shell the app shows while it is reading the chain,
 * which is also what the statically generated HTML contains: nothing that
 * claims to know the saver's balance before it does.
 *
 * No adapter packages either. Phantom, Solflare, Backpack and the rest
 * register through the Wallet Standard, which wallet-adapter discovers on its
 * own, so an empty list finds every wallet a person actually has installed.
 */
export function WalletProviders({ children }: { children: React.ReactNode }) {
  const [endpoint, setEndpoint] = useState<string | null>(null);

  useEffect(() => {
    setEndpoint(resolveRpcEndpoint());
  }, []);

  if (!endpoint) {
    return <BootShell />;
  }

  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

function BootShell() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col px-5 pb-10 pt-8">
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted">One moment</p>
      </div>
    </main>
  );
}
