/**
 * The motion system.
 *
 * One place defines every duration, easing and variant so the whole application
 * moves at the same tempo. Motion is limited to `transform` and `opacity`, which the
 * compositor can animate without touching layout.
 */

import type { Transition, Variants } from "framer-motion";

export const duration = {
  fast: 0.12,
  normal: 0.18,
  slow: 0.28,
  page: 0.22,
} as const;

export const ease = {
  standard: [0.2, 0, 0, 1],
  out: [0.16, 1, 0.3, 1],
  inOut: [0.65, 0, 0.35, 1],
} as const;

/** The spring used for anything that should feel physical (sidebar indicator). */
export const spring: Transition = {
  type: "spring",
  stiffness: 520,
  damping: 40,
  mass: 0.7,
};

export const springSoft: Transition = {
  type: "spring",
  stiffness: 320,
  damping: 32,
  mass: 0.8,
};

export const transition = {
  fast: { duration: duration.fast, ease: ease.standard } satisfies Transition,
  normal: { duration: duration.normal, ease: ease.out } satisfies Transition,
  slow: { duration: duration.slow, ease: ease.out } satisfies Transition,
} as const;

/** Page transition: a small lift and fade. Never a slide or a zoom. */
export const pageVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: duration.page, ease: ease.out } },
  exit: { opacity: 0, y: -6, transition: { duration: duration.fast, ease: ease.standard } },
};

/** Staggered list entrance used by the queue and the library. */
export const listVariants: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.028, delayChildren: 0.02 } },
  exit: { transition: { staggerChildren: 0.012, staggerDirection: -1 } },
};

export const itemVariants: Variants = {
  initial: { opacity: 0, y: 10, scale: 0.995 },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: duration.slow, ease: ease.out },
  },
  exit: {
    opacity: 0,
    y: -6,
    scale: 0.995,
    transition: { duration: duration.fast, ease: ease.standard },
  },
};

/** Dialog / popover surface. */
export const surfaceVariants: Variants = {
  initial: { opacity: 0, scale: 0.97, y: 8 },
  animate: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { duration: duration.normal, ease: ease.out },
  },
  exit: {
    opacity: 0,
    scale: 0.98,
    y: 4,
    transition: { duration: duration.fast, ease: ease.standard },
  },
};

export const backdropVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: duration.normal, ease: ease.standard } },
  exit: { opacity: 0, transition: { duration: duration.fast, ease: ease.standard } },
};

/** Toast entrance: rises from the bottom-right corner. */
export const toastVariants: Variants = {
  initial: { opacity: 0, y: 16, scale: 0.97 },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: springSoft,
  },
  exit: {
    opacity: 0,
    y: 8,
    scale: 0.98,
    transition: { duration: duration.fast, ease: ease.standard },
  },
};

/** Collapsible section used across Settings. */
export const collapseVariants: Variants = {
  initial: { height: 0, opacity: 0 },
  animate: {
    height: "auto",
    opacity: 1,
    transition: { duration: duration.slow, ease: ease.out },
  },
  exit: { height: 0, opacity: 0, transition: { duration: duration.normal, ease: ease.standard } },
};

/** Feedback for a button or icon press. */
export const pressable = {
  whileHover: { scale: 1.015 },
  whileTap: { scale: 0.975 },
  transition: { duration: duration.fast, ease: ease.standard },
} as const;
