/** Selection surfaces: the format selector's radio cards and picker rows. */

import { motion, useReducedMotion } from "framer-motion";
import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { duration, ease } from "@/lib/motion";

export interface RadioCardProps {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  leading?: ReactNode;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
  /** Renders a highlighted border used for the "recommended" row. */
  recommended?: boolean;
}

/**
 * A single selectable card.
 *
 * Selection is expressed with a border, a tinted surface and a scaling check mark —
 * all animated on `transform`/`opacity`/`background-color`, so a long list stays
 * cheap to update while a download is running.
 */
export function RadioCard({
  selected,
  onSelect,
  title,
  subtitle,
  trailing,
  leading,
  disabled = false,
  compact = false,
  recommended = false,
  className,
}: RadioCardProps) {
  const reduce = useReducedMotion();

  return (
    <motion.button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={onSelect}
      whileTap={reduce || disabled ? undefined : { scale: 0.994 }}
      transition={reduce ? undefined : { duration: duration.fast, ease: ease.standard }}
      className={cn(
        "group relative flex w-full items-center gap-3 border text-left transition-colors",
        compact
          ? "rounded-[var(--radius-md)] px-3 py-2"
          : "rounded-[var(--radius-lg)] px-3.5 py-3",
        selected
          ? "border-accent bg-accent-soft"
          : "border-line bg-surface hover:border-line-strong hover:bg-surface-hover",
        recommended && !selected && "border-accent/40",
        disabled && "cursor-not-allowed opacity-45 hover:border-line hover:bg-surface",
        className,
      )}
    >
      {leading}

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span
            className={cn(
              "text-label font-semibold tabular-nums",
              selected ? "text-accent" : "text-content",
            )}
          >
            {title}
          </span>
          {recommended ? (
            <span className="rounded-full bg-accent/12 px-1.5 py-px text-micro font-medium text-accent">
              推荐
            </span>
          ) : null}
        </span>
        {subtitle ? (
          <span className="truncate text-caption text-content-tertiary">{subtitle}</span>
        ) : null}
      </span>

      {trailing}

      <span
        className={cn(
          "flex size-[18px] shrink-0 items-center justify-center rounded-full border transition-colors",
          selected ? "border-accent bg-accent text-accent-contrast" : "border-line-strong",
        )}
      >
        {selected ? (
          <motion.span
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: duration.fast, ease: ease.out }}
          >
            <Check className="size-3" strokeWidth={3.2} />
          </motion.span>
        ) : null}
      </span>
    </motion.button>
  );
}

/** Wrapper that gives a set of radio cards the correct ARIA semantics. */
export function RadioCardGroup({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex flex-col gap-1.5", className)}>
      {children}
    </div>
  );
}
