import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // A savings app palette: warm paper, deep ink, one restrained accent.
        // Nothing here is red or green, because a savings balance should not
        // be colour coded like a trading screen.
        paper: "#FBF9F5",
        ink: "#16130F",
        // Secondary text. Dark enough that 12px and 13px copy on paper, on a
        // card and on accentSoft all clear WCAG AA (6.9:1, 7.1:1, 6.2:1),
        // because the quietest lines here are the ones about custody and
        // permission, and a saver who cannot read those cannot trust them.
        muted: "#5C564C",
        // Placeholders only. Lighter than muted so an empty field still reads
        // as empty, and still 4.8:1 on paper, where the old #E8E2D8 was 1.3:1.
        hint: "#756E62",
        line: "#E8E2D8",
        accent: "#1E6F5C",
        accentSoft: "#E6F0EC",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
