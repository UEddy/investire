"use client";

import { useId, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  ThemeChoice,
  applyChoice,
  readChoice,
  saveChoice,
  themeFor,
} from "@/lib/theme";

const CHOICES: { choice: ThemeChoice; label: string }[] = [
  { choice: "system", label: "System" },
  { choice: "light", label: "Light" },
  { choice: "dark", label: "Dark" },
];

/**
 * System, Light or Dark, at the foot of the screen in the quietest type there,
 * because most savers never need it: system is the default and follows the
 * phone.
 *
 * Switching crossfades the page once, through the browser's view transition.
 * It is the one transition here that is not a spring, since nothing moves and
 * there is only a colour to change. Under reduced motion the theme changes at
 * once, the way the share counter snaps rather than easing more slowly.
 */
export function ThemeControl() {
  const [choice, setChoice] = useState<ThemeChoice>(readChoice);
  const reduced = useReducedMotion();
  // One layoutId per copy of the control, so the pill slides between these
  // three buttons and never across from the copy on another screen.
  const pill = useId();

  const choose = (next: ThemeChoice) => {
    // System can already be showing the theme picked, and then there is
    // nothing to fade between.
    const changes = themeFor(next) !== themeFor(choice);
    setChoice(next);
    saveChoice(next);
    if (changes && !reduced && "startViewTransition" in document) {
      document.startViewTransition(() => applyChoice(next));
    } else {
      applyChoice(next);
    }
  };

  return (
    <div
      role="group"
      aria-label="Appearance"
      className="inline-flex rounded-full border border-line p-0.5"
    >
      {CHOICES.map((option) => {
        const selected = option.choice === choice;
        return (
          <button
            key={option.choice}
            type="button"
            aria-pressed={selected}
            onClick={() => choose(option.choice)}
            className={[
              "relative rounded-full px-3 py-1 text-[13px] font-medium",
              selected ? "text-paper" : "text-muted",
            ].join(" ")}
          >
            {selected ? (
              <motion.span
                layoutId={pill}
                className="absolute inset-0 rounded-full bg-ink"
              />
            ) : null}
            <span className="relative">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
