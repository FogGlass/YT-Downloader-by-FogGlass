/** Feedback surfaces: empty states, error states, toasts and key hints. */

import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { Button, IconButton } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { duration, ease, toastVariants } from "@/lib/motion";
import { useToastStore, type ToastKind } from "@/stores/toasts";

/* -------------------------------------------------------------------------- */
/* Empty and error states                                                     */
/* -------------------------------------------------------------------------- */

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  secondaryAction,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: duration.slow, ease: ease.out }}
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-14 text-center",
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-[var(--radius-lg)] border border-line bg-surface-elevated text-content-tertiary">
        <Icon className="size-5" strokeWidth={1.7} />
      </div>
      <div className="space-y-1">
        <h3 className="text-heading font-semibold text-content">{title}</h3>
        {description ? (
          <p className="mx-auto max-w-md text-label leading-[1.35rem] text-content-tertiary">
            {description}
          </p>
        ) : null}
      </div>
      {action || secondaryAction ? (
        <div className="mt-1 flex items-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </motion.div>
  );
}

export function ErrorState({
  title = "出错了",
  description,
  hint,
  detail,
  onRetry,
  onSecondary,
  secondaryLabel,
  extraAction,
  className,
}: {
  title?: string;
  description?: string;
  /** Actionable guidance shown above the raw output, e.g. how to fix a cookie store. */
  hint?: string | null;
  detail?: string | null;
  onRetry?: () => void;
  onSecondary?: () => void;
  secondaryLabel?: string;
  /** Additional recovery affordance, such as "retry without cookies". */
  extraAction?: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: duration.normal, ease: ease.out }}
      className={cn(
        "flex flex-col items-center gap-3 rounded-[var(--radius-lg)] border border-danger/30 bg-danger-soft px-6 py-8 text-center",
        className,
      )}
    >
      <AlertTriangle className="size-5 text-danger" strokeWidth={1.8} />
      <div className="space-y-1">
        <h3 className="text-label font-semibold text-content">{title}</h3>
        {description ? (
          <p className="mx-auto max-w-md text-caption leading-[1.15rem] text-content-secondary">
            {description}
          </p>
        ) : null}
      </div>

      {/* Guidance is the part a user can act on, so it is never hidden behind a
          collapsed "details" block. */}
      {hint ? (
        <p className="mx-auto max-w-md rounded-[var(--radius-sm)] border border-line bg-surface px-3 py-2 text-caption leading-[1.15rem] text-content-secondary">
          {hint}
        </p>
      ) : null}

      {detail ? (
        <pre className="selectable max-h-32 w-full overflow-auto rounded-[var(--radius-sm)] border border-line bg-surface-sunken p-2.5 text-left font-mono text-micro leading-[1.05rem] whitespace-pre-wrap text-content-tertiary">
          {detail}
        </pre>
      ) : null}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            重试
          </Button>
        ) : null}
        {extraAction}
        {onSecondary ? (
          <Button size="sm" variant="ghost" onClick={onSecondary}>
            {secondaryLabel ?? "取消"}
          </Button>
        ) : null}
      </div>
    </motion.div>
  );
}

/* -------------------------------------------------------------------------- */
/* Toasts                                                                     */
/* -------------------------------------------------------------------------- */

const TOAST_ICONS: Record<ToastKind, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

const TOAST_TONES: Record<ToastKind, string> = {
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-danger",
};

function ToastCard({
  id,
  kind,
  title,
  description,
  action,
  duration: lifetime,
}: {
  id: string;
  kind: ToastKind;
  title: string;
  description?: string;
  action?: { label: string; run: () => void };
  duration: number;
}) {
  const dismiss = useToastStore((state) => state.dismiss);
  const Icon = TOAST_ICONS[kind];

  useEffect(() => {
    if (lifetime <= 0) {
      return;
    }
    const timer = window.setTimeout(() => dismiss(id), lifetime);
    return () => window.clearTimeout(timer);
  }, [id, lifetime, dismiss]);

  return (
    <motion.div
      layout
      variants={toastVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="floating pointer-events-auto flex w-[22rem] items-start gap-3 rounded-[var(--radius-lg)] p-3.5"
      role="status"
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", TOAST_TONES[kind])} strokeWidth={2} />
      <div className="min-w-0 flex-1">
        <p className="text-label font-medium text-content">{title}</p>
        {description ? (
          <p className="mt-0.5 text-caption leading-[1.1rem] break-words text-content-tertiary">
            {description}
          </p>
        ) : null}
        {action ? (
          <button
            type="button"
            onClick={() => {
              action.run();
              dismiss(id);
            }}
            className="mt-2 text-caption font-medium text-accent hover:text-accent-hover"
          >
            {action.label}
          </button>
        ) : null}
      </div>
      <IconButton label="关闭提示" size="xs" onClick={() => dismiss(id)}>
        <X className="size-3.5" />
      </IconButton>
    </motion.div>
  );
}

/** Mounted once by the shell; renders the toast stack bottom-right. */
export function ToastHost() {
  const toasts = useToastStore((state) => state.toasts);
  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-[80] flex flex-col-reverse gap-2">
      <AnimatePresence initial={false} mode="popLayout">
        {toasts.map((toast) => (
          <ToastCard key={toast.id} {...toast} />
        ))}
      </AnimatePresence>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

/** A keyboard hint, e.g. Ctrl + Enter. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[var(--radius-xs)] border border-line bg-surface-elevated px-1.5 font-sans text-micro font-medium text-content-tertiary">
      {children}
    </kbd>
  );
}
