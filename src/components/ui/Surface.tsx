/** Surfaces, cards and small status vocabulary. */

import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  /** `panel` is flat, `raised` floats above the page, `glass` blurs behind. */
  tone?: "panel" | "raised" | "glass" | "sunken" | "plain";
  padded?: boolean;
}

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { tone = "panel", padded = false, className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        tone === "panel" && "panel",
        tone === "raised" && "panel-raised",
        tone === "glass" && "floating",
        tone === "sunken" && "bg-surface-sunken border border-line-subtle rounded-[var(--radius-lg)]",
        padded && "p-4",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
});

export type BadgeTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-hover text-content-secondary border-line",
  accent: "bg-accent-soft text-accent border-transparent",
  success: "bg-success-soft text-success border-transparent",
  warning: "bg-warning-soft text-warning border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  info: "bg-info-soft text-info border-transparent",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  icon?: ReactNode;
  /** Renders a small leading dot instead of an icon. */
  dot?: boolean;
}

export function Badge({
  tone = "neutral",
  icon,
  dot = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-[0.1875rem] text-micro font-medium tracking-[0.01em]",
        BADGE_TONES[tone],
        className,
      )}
      {...rest}
    >
      {dot ? <span className="size-1.5 rounded-full bg-current" aria-hidden /> : null}
      {icon}
      {children}
    </span>
  );
}

/** A compact key/value pair used across previews and about panels. */
export function MetaItem({
  label,
  value,
  className,
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <span className="text-micro uppercase tracking-[0.08em] text-content-tertiary">
        {label}
      </span>
      <span className="truncate text-label font-medium text-content" title={typeof value === "string" ? value : undefined}>
        {value}
      </span>
    </div>
  );
}

/** Section heading with an optional action slot. */
export function SectionHeader({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        <h2 className="text-heading font-semibold tracking-[-0.012em] text-content">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-label text-content-tertiary">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/** Status dot used by the sidebar footer and the runtime panel. */
export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  tone: "success" | "warning" | "danger" | "neutral" | "accent";
  pulse?: boolean;
  className?: string;
}) {
  const color =
    tone === "success"
      ? "bg-success"
      : tone === "warning"
        ? "bg-warning"
        : tone === "danger"
          ? "bg-danger"
          : tone === "accent"
            ? "bg-accent"
            : "bg-content-tertiary";
  return (
    <span className={cn("relative inline-flex size-2", className)} aria-hidden>
      <span className={cn("absolute inset-0 rounded-full", color)} />
      {pulse ? (
        <span
          className={cn("absolute inset-0 rounded-full animate-ping opacity-60", color)}
        />
      ) : null}
    </span>
  );
}
