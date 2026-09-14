/**
 * The outcome page.
 *
 * Success is a single drawn check — one circle and one tick — because that is the only
 * motion the moment needs. Failure reuses the exact same layout with a danger icon, the
 * backend's summary and its raw detail, so a broken install is as readable as a good one.
 */

import { motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, FolderOpen, Play, ShieldCheck, XCircle } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Surface } from "@/components/ui/Surface";
import { shortenPath } from "@/lib/format";
import { duration, ease } from "@/lib/motion";
import { errorMessage, launchApp, openPath } from "../api";
import type { SetupContext, SetupFinished } from "../types";

export interface DonePageProps {
  context: SetupContext;
  result: SetupFinished;
  /** Closes the installer window. */
  onClose: () => void;
  /** Install failures can go back to the options page; the backend already rolled back. */
  onRetry?: () => void;
}

export function DonePage({ context, result, onClose, onRetry }: DonePageProps) {
  const reduce = useReducedMotion();
  const [busy, setBusy] = useState<"launch" | "open" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const targetDir = result.installDir ?? context.installDir ?? context.defaultDir;
  const install = result.mode === "install";

  const run = useCallback(
    async (kind: "launch" | "open", action: () => Promise<void>) => {
      setActionError(null);
      setBusy(kind);
      try {
        await action();
      } catch (failure) {
        setActionError(errorMessage(failure));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  if (!result.ok) {
    return (
      <div className="flex flex-col items-center gap-4 text-center">
        <motion.div
          role="status"
          aria-label={install ? "安装未完成" : "卸载未完成"}
          initial={reduce ? false : { opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: duration.normal, ease: ease.out }}
          className="flex size-16 items-center justify-center rounded-full bg-danger-soft"
        >
          <XCircle className="size-7 text-danger" strokeWidth={1.8} aria-hidden />
        </motion.div>

        <div className="space-y-1">
          <h1 className="text-title font-semibold tracking-[-0.016em] text-content">
            {install ? "安装未完成" : "卸载未完成"}
          </h1>
          <p className="text-label leading-[1.35rem] text-content-secondary">
            {result.error ?? "安装程序未能完成操作。"}
          </p>
        </div>

        {result.detail ? (
          <pre className="selectable max-h-40 w-full overflow-auto rounded-[var(--radius-sm)] border border-line bg-surface-sunken p-2.5 text-left font-mono text-micro leading-[1.05rem] whitespace-pre-wrap text-content-tertiary">
            {result.detail}
          </pre>
        ) : null}

        <div className="flex flex-wrap items-center justify-center gap-2.5">
          <Button variant="primary" size="lg" onClick={onClose}>
            关闭
          </Button>
          {install && onRetry ? (
            <Button variant="ghost" size="lg" onClick={onRetry}>
              重新设置
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <SuccessMark label={install ? "安装完成" : "卸载完成"} />

      <div className="space-y-1">
        <h1 className="text-title font-semibold tracking-[-0.016em] text-content">
          {install ? "安装完成" : "卸载完成"}
        </h1>
        <p className="text-label leading-[1.35rem] text-content-secondary">
          {install
            ? `${context.appName} ${context.appVersion} 已就绪，可以直接开始使用。`
            : `${context.appName} 已从本机移除。`}
        </p>
      </div>

      {install ? (
        <Surface tone="panel" className="w-full px-4 py-3.5 text-left">
          <div className="flex flex-col gap-3">
            <PathLine label="安装位置" path={targetDir} />
            <PathLine label="版本" path={context.appVersion} mono={false} />
          </div>
        </Surface>
      ) : (
        <Surface tone="panel" className="w-full px-4 py-3.5 text-left">
          <div className="flex flex-col gap-3">
            <PathLine label="已移除" path={targetDir} />
            <div className="flex flex-col gap-2">
              <KeptLine
                label="应用设置、下载历史与收藏"
                path={`${targetDir}\\data`}
                kept={result.appDataKept}
              />
              <KeptLine
                label="已下载的视频文件"
                path={`${targetDir}\\data\\downloads`}
                kept={result.downloadsKept}
              />
            </div>
          </div>
        </Surface>
      )}

      {actionError ? (
        <p className="flex items-start gap-1.5 text-caption leading-[1.15rem] text-danger">
          <AlertTriangle className="mt-px size-3.5 shrink-0" strokeWidth={2} aria-hidden />
          <span className="min-w-0">{actionError}</span>
        </p>
      ) : null}

      {install ? (
        <div className="flex w-full flex-wrap items-center justify-center gap-2.5 pt-0.5">
          <Button
            variant="primary"
            size="lg"
            icon={<Play className="size-4" />}
            loading={busy === "launch"}
            disabled={busy !== null}
            onClick={() => void run("launch", launchApp)}
          >
            启动 {context.appName}
          </Button>
          <Button
            variant="secondary"
            size="lg"
            icon={<FolderOpen className="size-4" />}
            loading={busy === "open"}
            disabled={busy !== null}
            onClick={() => void run("open", () => openPath(targetDir))}
          >
            打开安装目录
          </Button>
          <Button variant="ghost" size="lg" onClick={onClose} disabled={busy !== null}>
            完成
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-center pt-0.5">
          <Button variant="primary" size="lg" onClick={onClose}>
            关闭
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The success check.
 *
 * `pathLength` is animated on the SVG itself, which keeps the work on the compositor,
 * and the container only settles by a few percent — no glow, no bounce, no confetti.
 */
function SuccessMark({ label }: { label: string }) {
  const reduce = useReducedMotion();

  return (
    <motion.div
      role="status"
      aria-label={label}
      initial={reduce ? false : { opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: duration.normal, ease: ease.out }}
      className="flex size-16 items-center justify-center rounded-full bg-success-soft"
    >
      <svg viewBox="0 0 44 44" className="size-10" aria-hidden>
        <motion.circle
          cx="22"
          cy="22"
          r="19"
          fill="none"
          stroke="var(--success)"
          strokeWidth="2.6"
          strokeLinecap="round"
          initial={reduce ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: duration.slow, ease: ease.out }}
        />
        <motion.path
          d="M14 22.6 L19.6 28.2 L30.4 16.4"
          fill="none"
          stroke="var(--success)"
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={reduce ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{
            duration: duration.slow,
            ease: ease.out,
            // The tick lands just as the circle closes.
            delay: duration.slow * 0.55,
          }}
        />
      </svg>
    </motion.div>
  );
}

/** Labelled path row; `mono` is off for values that are not filesystem paths. */
function PathLine({ label, path, mono = true }: { label: string; path: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-micro tracking-[0.08em] text-content-tertiary">{label}</span>
      <span
        className={mono ? "selectable truncate font-mono text-label text-content" : "truncate text-label font-medium text-content"}
        title={path}
      >
        {mono ? shortenPath(path, 52) : path}
      </span>
    </div>
  );
}

/** States plainly whether one kind of user data survived the uninstall. */
function KeptLine({ label, path, kept }: { label: string; path: string; kept: boolean }) {
  if (!kept) {
    return (
      <p className="flex items-start gap-1.5 text-caption leading-[1.15rem] text-danger">
        <AlertTriangle className="mt-px size-3.5 shrink-0" strokeWidth={2} aria-hidden />
        <span className="min-w-0">{label}已删除。</span>
      </p>
    );
  }

  return (
    <p className="flex items-start gap-1.5 text-caption leading-[1.15rem] text-content-secondary">
      <ShieldCheck className="mt-px size-3.5 shrink-0 text-success" strokeWidth={2} aria-hidden />
      <span className="min-w-0">
        {label}已保留：
        <span className="selectable font-mono break-all text-content-tertiary">{path}</span>
      </span>
    </p>
  );
}
