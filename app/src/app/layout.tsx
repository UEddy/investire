import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { WalletProviders } from "@/components/WalletProviders";
import { PALETTE } from "@/lib/palette";
import { THEME_SCRIPT } from "@/lib/theme";

/**
 * Noto Sans, from a file in this repository. next/font builds it in and serves
 * it from the app's own domain, so neither the build nor a visitor's browser
 * asks a font service for anything.
 *
 * A humanist sans, whose strokes keep a little of the pen, which suits paper
 * and ink. Its x-height is large, so the 12px and 13px lines about custody and
 * permission stay easy to read, and its figures come in a true tabular form,
 * which globals.css turns on everywhere. One variable file carries every
 * weight the app uses.
 *
 * Until the file arrives, text is set in a local Arial that next/font sizes
 * to Noto's measurements, so the swap moves nothing on the page.
 */
const notoSans = localFont({
  src: "./fonts/noto-sans-latin-wght.woff2",
  weight: "100 900",
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "Investire",
  description: "Save a little every week. Own shares.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // A savings app is a phone app. Lock the chrome to the page colour so the
  // status bar does not sit in a different world from the content. One tag
  // per system setting; a saver's own choice goes in a tag ahead of these.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: PALETTE.light.paper },
    { media: "(prefers-color-scheme: dark)", color: PALETTE.dark.paper },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // The theme script sets data-theme on <html> before React arrives, which
    // hydration would otherwise report as a mismatch. It is the only
    // attribute changed there, and suppressing the warning covers only this
    // element, not its children.
    <html lang="en" className={notoSans.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh antialiased">
        <WalletProviders>{children}</WalletProviders>
      </body>
    </html>
  );
}
