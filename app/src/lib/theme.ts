import { PALETTE, Theme } from "./palette";

/**
 * Which theme the saver picked. System follows the device and is the default,
 * so it is never stored: an empty slot means system, and a saver who never
 * touches the control gets whatever their phone is set to, including when it
 * changes at sunset.
 *
 * Only an explicit light or dark is remembered, in localStorage, on this
 * device and nowhere else.
 */
export type ThemeChoice = Theme | "system";

const STORAGE_KEY = "investire-theme";

/**
 * The browser chrome follows the page. With no choice made, the layout's two
 * theme-color tags already do that, one per system setting. A choice that
 * differs from the system needs its own tag, placed first in the head, since
 * the browser takes the first one that applies.
 */
const CHROME_ID = "theme-color-choice";

export function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    // Storage can be switched off. The app then follows the system, which is
    // what it would do anyway.
    return "system";
  }
}

export function saveChoice(choice: ThemeChoice): void {
  try {
    if (choice === "system") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, choice);
    }
  } catch {
    // Not remembered, but still applied for as long as the page is open.
  }
}

/** The theme a choice shows right now, resolving system against the device. */
export function themeFor(choice: ThemeChoice): Theme {
  if (choice !== "system") {
    return choice;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Puts a choice on the page. The palette's CSS does the rest: with no
 * attribute it follows prefers-color-scheme, and data-theme overrides it.
 */
export function applyChoice(choice: ThemeChoice): void {
  const root = document.documentElement;
  let chrome = document.getElementById(CHROME_ID) as HTMLMetaElement | null;

  if (choice === "system") {
    root.removeAttribute("data-theme");
    chrome?.remove();
    return;
  }

  root.setAttribute("data-theme", choice);
  if (!chrome) {
    chrome = document.createElement("meta");
    chrome.id = CHROME_ID;
    chrome.name = "theme-color";
    document.head.prepend(chrome);
  }
  chrome.content = PALETTE[choice].paper;
}

/**
 * applyChoice for a stored choice, as a string the layout inlines at the top
 * of <head>. A classic inline script there runs before the body is parsed and
 * blocks rendering until it has, so a saver who picked dark on a light phone
 * never sees one light frame. React is not loaded yet, which is why this is
 * its own few lines rather than a call into the functions above; it does
 * exactly what readChoice then applyChoice would.
 *
 * With nothing stored it does nothing at all, and CSS alone picks the theme.
 */
export const THEME_SCRIPT = `(function () {
  try {
    var choice = localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
    if (choice !== "light" && choice !== "dark") return;
    document.documentElement.setAttribute("data-theme", choice);
    var chrome = document.createElement("meta");
    chrome.id = ${JSON.stringify(CHROME_ID)};
    chrome.name = "theme-color";
    chrome.content = ${JSON.stringify({ light: PALETTE.light.paper, dark: PALETTE.dark.paper })}[choice];
    document.head.prepend(chrome);
  } catch (e) {}
})();`;
