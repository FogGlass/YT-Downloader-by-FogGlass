/**
 * The running page, shared by install and uninstall.
 *
 * Nothing here invents progress: the step list, the percentage and the "what is
 * happening now" line are all rendered straight from the backend's `setup:progress`
 * payload, and uninstall simply supplies different labels.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, XCircle } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { ProgressBar, Spinner, useSmoothedNumber } from "@/components/ui/Progress";
import { StatusDot, Surface } from "@/components/ui/Surface";
import { cn } from "@/lib/cn";
import { duration, ease } from "@/lib/motion";
import type { SetupMode, SetupProgress, StepState } from "../types";

/** Label treatment per step state. The colour is the only thing that changes. */
const STEP_TEXT: Record<StepState, string> = {
  pending: "text-content-tertiary",
  active: "font-medium text-accent",
  done: "text-content-secondary",
  failed: "font-medium text-danger",
};

export interface ProgressPageProps {
  mode: SetupMode;
  /** `null` until the first event arrives. */
  progress: SetupProgress | null;
  onCancel: () => void;
  cancelling: boolean;
  /** Set when `setup_cancel` itself was rejected. */
  cancelError?: string | null;
}

export function ProgressPage({
  mode,
  progress,
  onCancel,
  cancelling,
  cancelError,
}: ProgressPageProps) {
  const reduce = useReducedMotion();
  // One smoothed value feeds both the bar and the number, so they can never disagree.
  // 320 ms is short enough to keep up with a fast extraction yet removes the jitter of
  // several events per second.
  const smoothed = useSmoothedNumber(progress?.percent ?? 0, 320);

  const steps = progress?.steps ?? [];
  const doneCount = steps.filter((step) => step.state === "done").length;
  const failed = steps.some((step) => step.state === "failed");
  const last = steps.at(-1);
  // Once the last step is terminal the run is over; cancelling would do nothing.
  const terminal = last !== undefined && (last.state === "done" || last.state === "failed");

  const verb = mode === "install" ? "安装" : "卸载";

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title font-semibold tracking-[-0.016em] text-content">
        正在{verb}
      </h1>

      <Surface tone="panel" className="px-1 py-1">
        <ul className="flex flex-col" aria-label={`${verb}步骤`}>
          {steps.length === 0 ? (
            <li className="flex items-center gap-2.5 px-3 py-2.5">
              <StepIndicator state="active" />
              <span className="text-label text-content-tertiary">正在准备…</span>
            </li>
          ) : (
            steps.map((step) => (
              <li
                key={step.id}
                aria-current={step.state === "active" ? "step" : undefined}
                className="flex items-center gap-2.5 px-3 py-2.5"
              >
                <StepIndicator state={step.state} />
                {/* Keyed by state so a step cross-fades from muted to accent to success
                    instead of snapping to the new colour. */}
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={`${step.id}:${step.state}`}
                    initial={reduce ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={reduce ? undefined : { opacity: 0 }}
                    transition={{ duration: duration.fast, ease: ease.standard }}
                    className={cn("min-w-0 flex-1 truncate text-label", STEP_TEXT[step.state])}
                    title={step.label}
                  >
                    {step.label}
                  </motion.span>
                </AnimatePresence>
              </li>
            ))
          )}
        </ul>
      </Surface>

      <div className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-caption text-content-tertiary">
            {verb}进度
            {steps.length > 0 ? ` · ${doneCount} / ${steps.length}` : null}
          </span>
          <span className="text-label font-semibold tabular-nums text-content">
            {Math.round(smoothed * 100)}%
          </span>
        </div>

        <ProgressBar
          value={progress ? smoothed : null}
          tone={failed ? "danger" : "accent"}
          // The value is already interpolated frame by frame; a second CSS transition
          // would only add lag behind the backend.
          smooth={false}
        />

        {/* The honest "what is happening now" line. */}
        <p
          className="truncate font-mono text-micro text-content-tertiary"
          title={progress?.detail ?? undefined}
        >
          {progress?.detail ?? "等待安装程序返回进度…"}
        </p>
      </div>

      <div className="flex items-center gap-3 pt-0.5">
        <Button variant="ghost" size="md" onClick={onCancel} loading={cancelling} disabled={terminal}>
          取消
        </Button>
        {cancelError ? <span className="text-caption text-danger">{cancelError}</span> : null}
      </div>
    </div>
  );
}

/** Fixed-footprint state marker, so rows never shift as a step advances. */
function StepIndicator({ state }: { state: StepState }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {state === "active" ? (
        <Spinner size={14} className="text-accent" />
      ) : state === "done" ? (
        <Check className="size-3.5 text-success" strokeWidth={2.8} aria-hidden />
      ) : state === "failed" ? (
        <XCircle className="size-4 text-danger" strokeWidth={2} aria-hidden />
      ) : (
        <StatusDot tone="neutral" className="opacity-60" />
      )}
    </span>
  );
}
