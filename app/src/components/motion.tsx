"use client";

import { useEffect, useRef } from "react";
import {
  MotionConfig,
  Transition,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";

/**
 * Springs, not durations.
 *
 * A duration says how long something takes. A spring says how it moves, and
 * then interruption works properly: tap the card twice quickly and the second
 * tap redirects the motion from wherever it currently is rather than
 * restarting a timeline. For an app where the main gesture is opening and
 * closing one card, that is the whole difference between feeling responsive
 * and feeling animated at.
 */
export const SPRING: Transition = {
  type: "spring",
  stiffness: 420,
  damping: 38,
  mass: 0.9,
};

/** Softer, for larger things: screens arriving, the card growing. */
export const SPRING_SOFT: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 30,
  mass: 1,
};

/**
 * Wraps the app so every child animation inherits the spring, and so reduced
 * motion is honoured once rather than remembered at each call site.
 *
 * `reducedMotion="user"` makes Motion drop transform and layout animation when
 * the system asks for it, while leaving opacity alone. The important part is
 * what it does not do: it does not slow things down. Someone who asked for
 * less motion wants less of it, not the same amount taken longer.
 */
export function Motion({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig transition={SPRING} reducedMotion="user">
      {children}
    </MotionConfig>
  );
}

/**
 * The share counter.
 *
 * Shares only ever go up, one small weekly step at a time, and that is the
 * emotional core of the product. A number that simply swaps from 4.0068 to
 * 5.0085 states the fact; a number that travels there shows the thing
 * happening. The spring is slow and heavy on purpose: this is the one moment
 * in the app allowed to take its time.
 *
 * Under reduced motion it snaps. No easing, no shorter spring, just the value.
 */
export function ShareCounter({
  value,
  decimals = 4,
  className,
}: {
  value: number;
  decimals?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const spring = useSpring(0, { stiffness: 60, damping: 20, mass: 1 });
  const text = useTransform(spring, (current) =>
    current.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }),
  );

  const ref = useRef<HTMLSpanElement>(null);
  const started = useRef(false);

  useEffect(() => {
    if (reduced) {
      spring.jump(value);
      return;
    }
    // First paint counts up from zero, which is the reveal. Later changes
    // travel from wherever the number already was, so a weekly buy nudges it
    // rather than replaying the whole climb.
    if (!started.current) {
      started.current = true;
      spring.jump(0);
    }
    spring.set(value);
  }, [reduced, spring, value]);

  useEffect(
    () =>
      text.on("change", (latest) => {
        if (ref.current) {
          ref.current.textContent = latest;
        }
      }),
    [text],
  );

  return (
    <span ref={ref} className={className}>
      {value.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
    </span>
  );
}
