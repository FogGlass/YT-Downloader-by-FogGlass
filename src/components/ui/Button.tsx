/** Buttons and icon buttons. Every visual state is a token, never a literal. */

import { Slot } from "@radix-ui/react-slot";
import { Loader2 } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { duration } from "@/lib/motion";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "subtle"
  | "danger"
  | "success";

export type ButtonSize = "xs" | "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-contrast hover:bg-accent-hover shadow-[0_1px_2px_rgba(0,0,0,0.18)] active:translate-y-[0.5px]",
  secondary:
    "bg-surface-elevated text-content border border-line hover:bg-surface-hover hover:border-line-strong active:translate-y-[0.5px]",
  ghost:
    "text-content-secondary hover:text-content hover:bg-surface-hover active:bg-surface-active",
  subtle:
    "bg-surface-hover text-content hover:bg-surface-active border border-transparent hover:border-line",
  danger:
    "bg-danger-soft text-danger border border-transparent hover:bg-danger hover:text-white active:translate-y-[0.5px]",
  success:
    "bg-success-soft text-success border border-transparent hover:bg-success hover:text-white",
};

const SIZES: Record<ButtonSize, string> = {
  xs: "h-7 gap-1.5 px-2.5 text-caption rounded-[var(--radius-sm)]",
  sm: "h-8 gap-1.5 px-3 text-label rounded-[var(--radius-sm)]",
  md: "h-9.5 gap-2 px-4 text-body rounded-[var(--radius-md)]",
  lg: "h-11 gap-2 px-5 text-heading rounded-[var(--radius-md)]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  trailing?: ReactNode;
  /** Render the child element instead of a `<button>` (e.g. an `<a>`). */
  asChild?: boolean;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    icon,
    trailing,
    asChild = false,
    fullWidth = false,
    className,
    children,
    disabled,
    style,
    ...rest
  },
  ref,
) {
  const Component = asChild ? Slot : "button";

  return (
    <Component
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "relative inline-flex select-none items-center justify-center whitespace-nowrap font-medium",
        "transition-[background-color,border-color,color,transform,box-shadow] disabled:pointer-events-none",
        "disabled:opacity-45",
        VARIANTS[variant],
        SIZES[size],
        fullWidth && "w-full",
        className,
      )}
      style={{ transitionDuration: `${duration.fast * 1000}ms`, ...style }}
      {...rest}
    >
      {/* The label never unmounts while loading, so the button cannot jump. */}
      <span
        className={cn(
          "inline-flex items-center gap-[inherit] transition-opacity",
          loading && "opacity-0",
        )}
      >
        {icon}
        {children}
        {trailing}
      </span>
      {loading ? (
        <span className="absolute inset-0 inline-flex items-center justify-center">
          <Loader2 className="size-4 animate-spin" aria-hidden />
        </span>
      ) : null}
    </Component>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: "xs" | "sm" | "md";
  variant?: "ghost" | "subtle" | "secondary" | "danger";
  active?: boolean;
}

const ICON_SIZES = {
  xs: "size-7 rounded-[var(--radius-sm)]",
  sm: "size-8 rounded-[var(--radius-sm)]",
  md: "size-9.5 rounded-[var(--radius-md)]",
} as const;

const ICON_VARIANTS = {
  ghost: "text-content-tertiary hover:text-content hover:bg-surface-hover active:bg-surface-active",
  subtle: "text-content-secondary bg-surface-hover hover:bg-surface-active",
  secondary:
    "text-content-secondary bg-surface-elevated border border-line hover:text-content hover:bg-surface-hover",
  danger: "text-danger hover:bg-danger-soft",
} as const;

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { label, size = "sm", variant = "ghost", active = false, className, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        title={label}
        aria-label={label}
        aria-pressed={active || undefined}
        className={cn(
          "inline-flex shrink-0 items-center justify-center transition-colors disabled:pointer-events-none disabled:opacity-40",
          ICON_SIZES[size],
          ICON_VARIANTS[variant],
          active && "text-accent bg-accent-soft",
          className,
        )}
        style={{ transitionDuration: `${duration.fast * 1000}ms` }}
        {...rest}
      />
    );
  },
);
