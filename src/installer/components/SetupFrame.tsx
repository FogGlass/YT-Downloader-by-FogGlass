/**
 * The installer window frame.
 *
 * It mirrors the main application's title bar (`components/shell/TitleBar.tsx`) minus
 * the minimise/maximise controls, so the installer reads as the same product instead of
 * a second, separately designed wizard. Every installer page renders inside it.
 */

import { motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { IconButton } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Overlay";
import { ease } from "@/lib/motion";

/**
 * The window's entrance.
 *
 * Local rather than taken from `duration` because it belongs to window chrome — it is
 * tuned so the window has settled by the time the page transition starts, not to the
 * page-to-page tempo the rest of the app shares.
 */
const WINDOW_FADE_SECONDS = 0.26;

export interface SetupFrameProps {
  appName: string;
  appVersion?: string | null;
  /** Left-hand footer slot: the current step count or the phase summary. */
  footer?: ReactNode;
  /** Closes the installer window (`setup_close`). */
  onClose: () => void;
  children: ReactNode;
}

export function SetupFrame({
  appName,
  appVersion,
  footer,
  onClose,
  children,
}: SetupFrameProps) {
  const reduce = useReducedMotion();

  return (
    <motion.div
      // `initial={false}` under reduced motion: the window appears in place instead of
      // fading, which is what the OS setting asks for.
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: WINDOW_FADE_SECONDS, ease: ease.out }}
      className="relative flex h-full w-full flex-col overflow-hidden bg-background"
    >
      {/* 44px drag region. No minimise/maximise: setup windows are not resized by users. */}
      <header
        data-tauri-drag-region
        className="glass drag-region relative z-30 flex h-11 shrink-0 items-center gap-3 border-b border-line px-3"
      >
        <div className="flex min-w-0 items-center gap-2.5 pl-1" data-tauri-drag-region>
          <img src="/icon.png" alt="" className="size-5 rounded-[6px]" />
          <span className="truncate text-label font-semibold tracking-[-0.01em] text-content">
            {appName}
          </span>
        </div>

        <div className="flex-1" data-tauri-drag-region />

        <div className="no-drag flex items-center">
          <Tooltip label="关闭">
            <IconButton
              label="关闭安装程序"
              onClick={onClose}
              className="hover:bg-danger-soft hover:text-danger"
            >
              <X className="size-4" />
            </IconButton>
          </Tooltip>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {/* The same ambient gradients the main window paints behind its pages. The CSS
            already switches them off for reduced motion, so rendering it is always safe. */}
        <div className="ambient" aria-hidden />

        <div className="relative z-10 min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[34rem] flex-col px-6 py-6">{children}</div>
        </div>
      </div>

      <footer className="relative z-30 flex h-8 shrink-0 items-center justify-between gap-4 border-t border-line px-4 text-micro text-content-tertiary">
        <span className="truncate">{footer}</span>
        {appVersion ? (
          <span className="shrink-0 tabular-nums">版本 {appVersion}</span>
        ) : null}
      </footer>
    </motion.div>
  );
}
