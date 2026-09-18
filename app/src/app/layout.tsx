import type { Metadata, Viewport } from "next";
import "./globals.css";
import { WalletProviders } from "@/components/WalletProviders";

export const metadata: Metadata = {
  title: "Investire",
  description: "Save a little every week. Own shares.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // A savings app is a phone app. Lock the chrome to the page colour so the
  // status bar does not sit in a different world from the content.
  themeColor: "#FBF9F5",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <WalletProviders>{children}</WalletProviders>
      </body>
    </html>
  );
}
