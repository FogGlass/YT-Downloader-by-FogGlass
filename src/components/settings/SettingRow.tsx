/**
 * One row of the preferences list.
 *
 * Every setting in the application is presented the same way: a title that names the
 * field, a description that states what the backend actually does with it, and one
 * control. The row is deliberately stateless — it never interprets a value, it only
 * lays it out — so a screen is readable as a list of label/control pairs.
 */

import { AlertTriangle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface SettingRowProps {
  /** Names the field, in the user's language. */
  title: string;
  /** What the setting does — one sentence, no marketing. */
  description?: string;
  /** The value currently in effect, shown under the description. */
  value?: ReactNode;
  /** Advisory text in the warning tone. It never blocks the change. */
  warning?: string | null;
  /** Optional leading icon; keep it to one per group of rows. */
  icon?: LucideIcon;
  /**
   * `inline` keeps the control on the right (switches, sliders, selects);
   * `stacked` gives it the full width (paths, templates, text areas).
   */
  layout?: "inline" | "stacked";
  /** Wires the title up as a label for the control it describes. */
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

export function SettingRow({
  title,
  description,
  value,
  warning,
  icon: Icon,
  layout = "inline",
  htmlFor,
  children,
  className,
}: SettingRowProps) {
  return (
    <div
      className={cn(
        "px-4 py-3.5",
        layout === "inline"
          ? "flex items-center justify-between gap-6"
          : "flex flex-col gap-2.5",
        className,
      )}
    >
      <div className={cn("flex min-w-0 items-start gap-3", layout === "inline" && "flex-1")}>
        {Icon ? (
          <span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-line-subtle bg-surface-muted text-content-tertiary">
            <Icon className="size-3.5" strokeWidth={1.85} />
          </span>
        ) : null}

        <div className="min-w-0 flex-1">
          {/* A real <label> only when it points at a control; otherwise plain text so
              the accessibility tree is not filled with unassociated labels. */}
          {htmlFor ? (
            <label htmlFor={htmlFor} className="block text-label font-medium text-content">
              {title}
            </label>
          ) : (
            <span className="block text-label font-medium text-content">{title}</span>
          )}

          {description ? (
            <p className="mt-0.5 text-caption leading-[1.1rem] text-content-tertiary">
              {description}
            </p>
          ) : null}

          {value ? (
            <p className="mt-1 text-caption leading-[1.05rem] break-all text-content-secondary">
              {value}
            </p>
          ) : null}

          {warning ? (
            <p className="mt-1.5 flex items-start gap-1.5 text-caption leading-[1.05rem] text-warning">
              <AlertTriangle className="mt-px size-3.5 shrink-0" strokeWidth={2} aria-hidden />
              <span className="min-w-0">{warning}</span>
            </p>
          ) : null}
        </div>
      </div>

      <div
        className={cn(
          "flex items-center gap-2",
          layout === "inline" ? "shrink-0" : "w-full",
        )}
      >
        {children}
      </div>
    </div>
  );
}
