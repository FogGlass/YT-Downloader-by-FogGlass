/** Overlays: dialogs, confirms, tooltips, popovers, menus, tabs, scroll areas. */

import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button, IconButton } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { backdropVariants, spring, surfaceVariants } from "@/lib/motion";
import { useUiStore } from "@/stores/ui";

/* -------------------------------------------------------------------------- */
/* Tooltip                                                                    */
/* -------------------------------------------------------------------------- */

/** Mounted once by the shell so every tooltip shares one timing configuration. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={380} skipDelayDuration={220}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function Tooltip({
  label,
  children,
  side = "bottom",
  disabled = false,
}: {
  label: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  disabled?: boolean;
}) {
  if (disabled || !label) {
    return <>{children}</>;
  }
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="floating z-[70] max-w-64 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-caption text-content-secondary"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* Dialog                                                                     */
/* -------------------------------------------------------------------------- */

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Hide the close affordance for destructive confirmations. */
  hideClose?: boolean;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  hideClose = false,
}: DialogProps) {
  const width =
    size === "sm" ? "w-[26rem]" : size === "lg" ? "w-[42rem]" : "w-[34rem]";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                variants={backdropVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="fixed inset-0 z-[60] bg-overlay backdrop-blur-[2px]"
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content asChild forceMount>
              <motion.div
                variants={surfaceVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className={cn(
                  "floating fixed top-1/2 left-1/2 z-[61] -translate-x-1/2 -translate-y-1/2 p-5",
                  width,
                )}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <DialogPrimitive.Title className="text-heading font-semibold tracking-[-0.012em] text-content">
                      {title}
                    </DialogPrimitive.Title>
                    {description ? (
                      <DialogPrimitive.Description className="mt-1 text-label leading-[1.25rem] text-content-tertiary">
                        {description}
                      </DialogPrimitive.Description>
                    ) : null}
                  </div>
                  {hideClose ? null : (
                    <DialogPrimitive.Close asChild>
                      <IconButton label="关闭">
                        <X className="size-4" />
                      </IconButton>
                    </DialogPrimitive.Close>
                  )}
                </div>

                {children ? <div className="mt-4">{children}</div> : null}
                {footer ? (
                  <div className="mt-5 flex items-center justify-end gap-2">{footer}</div>
                ) : null}
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        ) : null}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}

/**
 * Renders whatever confirmation the UI store currently holds.
 *
 * Important actions (cancelling a download, deleting a file) always route through
 * here — the app never calls `window.confirm`.
 */
export function ConfirmHost() {
  const confirm = useUiStore((state) => state.confirm);
  const closeConfirm = useUiStore((state) => state.closeConfirm);
  const [busy, setBusy] = useState(false);

  const open = confirm !== null;

  const handleConfirm = async () => {
    if (!confirm) {
      return;
    }
    setBusy(true);
    try {
      await confirm.onConfirm();
    } finally {
      setBusy(false);
      closeConfirm();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (!next ? closeConfirm() : undefined)}
      title={confirm?.title ?? ""}
      description={confirm?.description}
      size="sm"
      hideClose
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={closeConfirm} disabled={busy}>
            {confirm?.cancelLabel ?? "取消"}
          </Button>
          <Button
            variant={confirm?.danger ? "danger" : "primary"}
            size="sm"
            loading={busy}
            onClick={handleConfirm}
          >
            {confirm?.confirmLabel ?? "确定"}
          </Button>
        </>
      }
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Popover and menu                                                           */
/* -------------------------------------------------------------------------- */

export function Popover({
  trigger,
  children,
  align = "end",
  side = "bottom",
  className,
  open,
  onOpenChange,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          side={side}
          sideOffset={8}
          className={cn("floating z-[65] p-3 outline-none", className)}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export function Menu({
  trigger,
  children,
  align = "end",
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
}) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>{trigger}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align={align}
          sideOffset={6}
          className="floating z-[65] min-w-52 overflow-hidden rounded-[var(--radius-md)] p-1"
        >
          {children}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export function MenuItem({
  icon,
  children,
  onSelect,
  danger = false,
  disabled = false,
  shortcut,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
}) {
  return (
    <DropdownMenuPrimitive.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-label outline-none select-none",
        "data-[highlighted]:bg-surface-hover",
        danger ? "text-danger data-[highlighted]:bg-danger-soft" : "text-content-secondary",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      {icon}
      <span className="flex-1">{children}</span>
      {shortcut ? (
        <span className="text-micro text-content-tertiary">{shortcut}</span>
      ) : null}
    </DropdownMenuPrimitive.Item>
  );
}

export function MenuSeparator() {
  return <DropdownMenuPrimitive.Separator className="my-1 h-px bg-line" />;
}

/* -------------------------------------------------------------------------- */
/* Tabs and scroll area                                                       */
/* -------------------------------------------------------------------------- */

export function Tabs({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <TabsPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      className={className}
    >
      {children}
    </TabsPrimitive.Root>
  );
}

export function TabsList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <TabsPrimitive.List
      className={cn(
        "inline-flex items-center gap-4 border-b border-line",
        className,
      )}
    >
      {children}
    </TabsPrimitive.List>
  );
}

/**
 * Tab trigger whose underline is a shared element: switching tabs slides the
 * underline rather than hiding one and showing another.
 */
export function TabsTrigger({
  value,
  children,
  layoutId,
  badge,
}: {
  value: string;
  children: ReactNode;
  layoutId: string;
  badge?: string;
}) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className="group relative -mb-px inline-flex items-center gap-1.5 px-1 pb-2.5 text-label font-medium text-content-tertiary transition-colors hover:text-content-secondary data-[state=active]:text-content"
    >
      {children}
      {badge ? (
        <span className="rounded-full bg-surface-active px-1.5 text-micro tabular-nums text-content-tertiary">
          {badge}
        </span>
      ) : null}
      <span className="pointer-events-none absolute inset-x-0 -bottom-px hidden h-0.5 group-data-[state=active]:block">
        <motion.span
          layoutId={layoutId}
          transition={spring}
          className="block h-0.5 w-full rounded-full bg-accent"
        />
      </span>
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <TabsPrimitive.Content value={value} className={cn("outline-none", className)}>
      {children}
    </TabsPrimitive.Content>
  );
}

export function ScrollArea({
  children,
  className,
  viewportClassName,
}: {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
}) {
  return (
    <ScrollAreaPrimitive.Root className={cn("relative overflow-hidden", className)}>
      <ScrollAreaPrimitive.Viewport className={cn("h-full w-full", viewportClassName)}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className="flex w-2 touch-none select-none p-0.5"
      >
        <ScrollAreaPrimitive.Thumb className="flex-1 rounded-full bg-content-tertiary/30" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}
