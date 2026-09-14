/** Progress, loading and placeholder primitives. */

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { duration, ease } from "@/lib/motion";

export interface ProgressBarProps {
  /** 0 – 1. `null` renders an indeterminate sweep. */
  value: number | null;
  className?: string;
  tone?: "accent" | "success" | "danger" | "warning";
  height?: number;
  /** Animate the fill towards new values instead of snapping. */
  smooth?: boolean;
}

const TONES = {
  accent: "bg-accent",
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
} as const;

export function ProgressBar({
  value,
  className,
  tone = "accent",
  height = 6,
  smooth = true,
}: ProgressBarProps) {
  const reduce = useReducedMotion();
  const indeterminate = value === null || Number.isNaN(value);
  const percent = indeterminate ? 0 : Math.max(0, Math.min(1, value)) * 100;

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(percent)}
      className={cn(
        "relative w-full overflow-hidden rounded-full bg-surface-active",
        indeterminate && "indeterminate-bar",
        className,
      )}
      style={{ height }}
    >
      <div
        className={cn("h-full rounded-full", TONES[tone])}
        style={{
          width: `${percent}%`,
          transition: smooth && !reduce ? `width ${duration.slow}s ${ease.out.join(",")}` : undefined,
          // A hairline highlight keeps the bar from looking like a flat rectangle.
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18)",
        }}
      />
    </div>
  );
}

/**
 * A circular progress ring used on download cards.
 *
 * The stroke is animated on the SVG element itself, so the animation stays on the
 * compositor and never triggers layout.
 */
export function ProgressRing({
  value,
  size = 46,
  stroke = 4,
  tone = "accent",
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  tone?: "accent" | "success" | "danger" | "warning";
  children?: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, value));
  const color =
    tone === "success"
      ? "var(--success)"
      : tone === "danger"
        ? "var(--danger)"
        : tone === "warning"
          ? "var(--warning)"
          : "var(--accent)";

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--surface-active)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
          style={{
            transition: reduce
              ? undefined
              : `stroke-dashoffset ${duration.slow}s ${ease.out.join(",")}`,
          }}
        />
      </svg>
      {children ? (
        <span className="absolute inset-0 flex items-center justify-center text-micro font-semibold tabular-nums text-content-secondary">
          {children}
        </span>
      ) : null}
    </div>
  );
}

export function Skeleton({
  className,
  rounded = "md",
}: {
  className?: string;
  rounded?: "sm" | "md" | "lg" | "full";
}) {
  const radius =
    rounded === "full"
      ? "rounded-full"
      : rounded === "lg"
        ? "rounded-[var(--radius-lg)]"
        : rounded === "sm"
          ? "rounded-[var(--radius-sm)]"
          : "rounded-[var(--radius-md)]";
  return <div className={cn("skeleton", radius, className)} aria-hidden />;
}

/** A skeleton that mirrors the shape of a download card. */
export function TaskCardSkeleton() {
  return (
    <div className="panel flex items-center gap-4 p-3.5">
      <Skeleton className="h-14 w-24" rounded="sm" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-1.5 w-full" rounded="full" />
      </div>
    </div>
  );
}

export function Spinner({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-block animate-spin rounded-full border-2 border-current border-t-transparent", className)}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

/**
 * Counts smoothly towards a target so rapid progress updates never look jittery.
 */
export function useSmoothedNumber(target: number, durationMs = 420): number {
  const [value, setValue] = useState(target);
  const frame = useRef<number | null>(null);
  const from = useRef(target);
  const start = useRef(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce) {
      setValue(target);
      return;
    }
    from.current = value;
    start.current = performance.now();

    const tick = (now: number) => {
      const elapsed = now - start.current;
      const progress = Math.min(1, elapsed / durationMs);
      const eased = 1 - (1 - progress) ** 3;
      setValue(from.current + (target - from.current) * eased);
      if (progress < 1) {
        frame.current = requestAnimationFrame(tick);
      }
    };

    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
      }
    };
    // `value` is intentionally excluded: it is the animation's own state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs, reduce]);

  return value;
}

/** Wrap a list so its children animate in without a manual transition prop. */
export function AnimatedNumber({
  value,
  format,
  className,
}: {
  value: number;
  format: (value: number) => string;
  className?: string;
}) {
  const smoothed = useSmoothedNumber(value);
  return (
    <motion.span
      className={cn("tabular-nums", className)}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: duration.fast }}
    >
      {format(smoothed)}
    </motion.span>
  );
}
