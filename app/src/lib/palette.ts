/**
 * The palette, in both themes, and the only place in the app a colour is
 * written down.
 *
 * A savings app palette: warm paper, deep ink, one restrained accent. Nothing
 * here is red or green, because a savings balance should not be colour coded
 * like a trading screen.
 *
 * Components never see these values. Each token becomes a colour class
 * (`bg-card`, `text-muted`) that reads a CSS variable, and the theme swaps
 * the variable underneath it, so no component knows which theme it is in and
 * none can be right in one and invisible in the other. tailwind.config.ts
 * emits the variables from here, the layout reads the paper colours for the
 * browser chrome, and scripts/verify-devnet.ts fails on a colour written
 * anywhere else and on any pair the screens render that falls below WCAG AA
 * in either theme. The ratios quoted below are the ones it checks.
 *
 * Dark keeps the palette warm. Its page is the light theme's ink, a warm
 * near-black rather than black, and every grey in it leans the same way the
 * light ones do. Its quiet text keeps the light theme's floor, not just AA's.
 */
export const TOKENS = [
  "paper",
  "card",
  "ink",
  "muted",
  "hint",
  "line",
  "accent",
  "accentSoft",
  "scrim",
] as const;

export type Token = (typeof TOKENS)[number];
export type Theme = "light" | "dark";
export type Palette = Record<Token, string>;

export const PALETTE: Record<Theme, Palette> = {
  light: {
    // The page, and the text on anything filled with ink or accent.
    paper: "#FBF9F5",
    // Cards, one step up from the page: exactly what their old white at 60%
    // came to over paper, so light mode looks as it did.
    card: "#FDFDFB",
    ink: "#16130F",
    // Secondary text. Dark enough that 12px and 13px copy on paper, on a
    // card and on accentSoft all clear WCAG AA (6.9:1, 7.1:1, 6.2:1),
    // because the quietest lines here are the ones about custody and
    // permission, and a saver who cannot read those cannot trust them.
    muted: "#5C564C",
    // Placeholders only. Lighter than muted so an empty field still reads
    // as empty, and still 4.8:1 on paper and 5.0:1 on the card the inputs
    // sit on.
    hint: "#756E62",
    line: "#E8E2D8",
    accent: "#1E6F5C",
    accentSoft: "#E6F0EC",
    // Behind a dialog. Only the wallet picker has one.
    scrim: "#16130F",
  },
  dark: {
    // The light theme's ink, so the page is warm and never pure black.
    paper: "#16130F",
    // Further up from the page than in light, because a small step between
    // two dark colours is harder to see than the same step between two light
    // ones.
    card: "#1E1A15",
    // Warm off-white rather than the light page itself: 15.7:1 on paper,
    // bright enough to read and short of the glare full white has here.
    ink: "#F1ECE4",
    // Light enough to keep the light theme's floor of 6.2:1: 7.5:1 on paper,
    // 7.0:1 on a card, 6.3:1 on accentSoft.
    muted: "#ACA497",
    // 5.2:1 on the card the inputs sit on.
    hint: "#948C7D",
    line: "#332D26",
    // The same green, lifted so it reads on dark: 8.3:1 on paper, and paper
    // on it for the one button filled with it.
    accent: "#6BBCA8",
    accentSoft: "#1A2722",
    // Darker than the page, or a dialog could not dim it.
    scrim: "#0B0907",
  },
};
