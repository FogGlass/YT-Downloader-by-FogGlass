/**
 * The installer window's root component.
 *
 * It owns the three things the pages must agree on: the setup context, the phase state
 * machine, and the two backend subscriptions. Pages stay presentational — they receive
 * data and call back — so install and uninstall can share one progress and one outcome
 * layout without either of them owning global state.
 */

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { ErrorState } from "@/components/ui/Feedback";
import { TooltipProvider } from "@/components/ui/Overlay";
import { Skeleton } from "@/components/ui/Progress";
import { pageVariants } from "@/lib/motion";
import {
  cancelSetup,
  closeSetup,
  errorDetail,
  errorMessage,
  getSetupContext,
  onSetupFinished,
  onSetupProgress,
  type Unsubscribe,
} from "./api";
import { SetupFrame } from "./components/SetupFrame";
import { DonePage } from "./pages/DonePage";
import { OptionsPage } from "./pages/OptionsPage";
import { ProgressPage } from "./pages/ProgressPage";
import { UninstallPage } from "./pages/UninstallPage";
import type { SetupContext, SetupFinished, SetupPhase, SetupProgress } from "./types";

interface LoadError {
  message: string;
  detail: string | null;
}

/** Left-hand footer line: the step count once running, the phase otherwise. */
function describeFooter(
  context: SetupContext | null,
  phase: SetupPhase,
  progress: SetupProgress | null,
  finished: SetupFinished | null,
): string {
  if (!context) {
    return "正在读取安装信息";
  }
  if (phase === "running") {
    const steps = progress?.steps ?? [];
    if (steps.length === 0) {
      return "正在准备…";
    }
    const done = steps.filter((step) => step.state === "done").length;
    return `步骤 ${done} / ${steps.length}`;
  }
  if (phase === "done") {
    const verb = context.mode === "install" ? "安装" : "卸载";
    return finished?.ok ? `${verb}已完成` : `${verb}未完成`;
  }
  return context.mode === "install" ? "准备安装" : "准备卸载";
}

export function InstallerApp() {
  const [context, setContext] = useState<SetupContext | null>(null);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [phase, setPhase] = useState<SetupPhase>("options");
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [finished, setFinished] = useState<SetupFinished | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const next = await getSetupContext();
      setContext(next);
      setPhase(next.mode === "uninstall" ? "uninstall" : "options");
    } catch (failure) {
      setLoadError({ message: errorMessage(failure), detail: errorDetail(failure) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // One subscription for the life of the window. The `disposed` flag covers the case
  // where React unmounts (StrictMode, or a closing window) while `listen` is still
  // resolving — the handles are then disposed instead of leaking a listener.
  useEffect(() => {
    let disposed = false;
    const disposers: Unsubscribe[] = [];

    const attach = async () => {
      const [offProgress, offFinished] = await Promise.all([
        onSetupProgress((next) => setProgress(next)),
        onSetupFinished((result) => {
          setFinished(result);
          setPhase("done");
        }),
      ]);
      if (disposed) {
        offProgress();
        offFinished();
        return;
      }
      disposers.push(offProgress, offFinished);
    };

    // Outside Tauri `listen` rejects; the commands would fail just as loudly, so there
    // is nothing to recover from here.
    void attach().catch(() => undefined);

    return () => {
      disposed = true;
      for (const dispose of disposers) {
        dispose();
      }
    };
  }, []);

  const close = useCallback(() => {
    void closeSetup();
  }, []);

  const started = useCallback(() => {
    setProgress(null);
    setFinished(null);
    setCancelError(null);
    setPhase("running");
  }, []);

  const retry = useCallback(() => {
    setProgress(null);
    setFinished(null);
    setCancelError(null);
    setPhase(context?.mode === "uninstall" ? "uninstall" : "options");
  }, [context]);

  const cancel = useCallback(async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      // The backend reports the outcome through `setup:finished`, so there is nothing
      // to do with a success here beyond releasing the button.
      await cancelSetup();
    } catch (failure) {
      setCancelError(errorMessage(failure));
    } finally {
      setCancelling(false);
    }
  }, []);

  const stage: "loading" | "error" | SetupPhase = loadError
    ? "error"
    : context
      ? phase
      : "loading";

  let content: ReactNode;
  if (loadError) {
    content = (
      <ErrorState
        title="无法启动安装程序"
        description={loadError.message}
        detail={loadError.detail}
        onRetry={() => void load()}
        onSecondary={close}
        secondaryLabel="关闭窗口"
      />
    );
  } else if (!context) {
    content = <LoadingPanel />;
  } else if (phase === "uninstall") {
    content = <UninstallPage context={context} onStarted={started} onClose={close} />;
  } else if (phase === "done" && finished) {
    content = (
      <DonePage
        context={context}
        result={finished}
        onClose={close}
        onRetry={finished.mode === "install" ? retry : undefined}
      />
    );
  } else if (phase === "running" || phase === "done") {
    // `done` without a result would mean the event payload was lost; keeping the
    // progress page up is more honest than flashing an empty outcome.
    content = (
      <ProgressPage
        mode={context.mode}
        progress={progress}
        cancelling={cancelling}
        cancelError={cancelError}
        onCancel={() => void cancel()}
      />
    );
  } else {
    content = <OptionsPage context={context} onStarted={started} onClose={close} />;
  }

  return (
    <TooltipProvider>
      <SetupFrame
        appName={context?.appName ?? "YT Downloader"}
        appVersion={context?.appVersion ?? null}
        footer={describeFooter(context, phase, progress, finished)}
        onClose={close}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={stage}
            variants={pageVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="w-full min-w-0"
          >
            {content}
          </motion.div>
        </AnimatePresence>
      </SetupFrame>
    </TooltipProvider>
  );
}

/** Placeholder that mirrors the shape of the options page while context loads. */
function LoadingPanel() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="正在读取安装信息">
      <div className="flex items-center gap-3.5">
        <Skeleton className="size-12" rounded="lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      <Skeleton className="h-24" rounded="lg" />
      <Skeleton className="h-36" rounded="lg" />
      <Skeleton className="h-16" rounded="lg" />
      <Skeleton className="h-11" rounded="lg" />
    </div>
  );
}
