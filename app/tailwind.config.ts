import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import { PALETTE, TOKENS, type Palette } from "./src/lib/palette";

// "#FBF9F5" as "251 249 245", the form rgb() takes with an alpha after a
// slash, which is what keeps `text-paper/70` working now that paper is a
// variable rather than a value.
const channels = (hex: string) =>
  [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(" ");

const variables = (palette: Palette) =>
  Object.fromEntries(
    TOKENS.map((token) => [`--color-${token}`, channels(palette[token])]),
  );

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    // Replaces Tailwind's palette rather than extending it. The only colours
    // a class can name are the tokens, so text-white or bg-gray-100 generate
    // nothing at all instead of a colour fixed across both themes.
    colors: {
      transparent: "transparent",
      current: "currentColor",
      ...Object.fromEntries(
        TOKENS.map((token) => [token, `rgb(var(--color-${token}) / <alpha-value>)`]),
      ),
    },
    extend: {
      // A bare `border` is a line, not Tailwind's grey.
      borderColor: { DEFAULT: "rgb(var(--color-line) / <alpha-value>)" },
      fontFamily: {
        // --font-sans is Noto Sans, from layout.tsx. The fallback inside var()
        // keeps the declaration valid if the variable ever goes missing again:
        // without one the browser drops the whole font-family and sets the
        // app in its default serif, which is what it did before.
        sans: ["var(--font-sans, system-ui)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [
    // The tokens' values. With nothing chosen the device decides; a choice
    // on this device sets data-theme on <html>, and that wins either way.
    plugin(({ addBase }) => {
      addBase({
        ":root": { colorScheme: "light", ...variables(PALETTE.light) },
        "@media (prefers-color-scheme: dark)": {
          ':root:not([data-theme="light"])': {
            colorScheme: "dark",
            ...variables(PALETTE.dark),
          },
        },
        ':root[data-theme="dark"]': {
          colorScheme: "dark",
          ...variables(PALETTE.dark),
        },
      });
    }),
  ],
} satisfies Config;
