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
        muted: "#6B6459",
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
