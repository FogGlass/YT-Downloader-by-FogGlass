/**
 * The installer's only pre-install page.
 *
 * One screen, one primary action: everything the backend needs is collected here, and
 * the target directory is verified live so the button is only enabled while the install
 * can actually succeed.
 */

import {
  AlertTriangle,
  Check,
  Download,
  ExternalLink,
  FolderOpen,
  HardDrive,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Field, Switch } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Overlay";
import { Spinner } from "@/components/ui/Progress";
import { MetaItem, Surface } from "@/components/ui/Surface";
import { formatBytes, shortenPath } from "@/lib/format";
import {
  checkDirectory,
  errorDetail,
  errorMessage,
  openPath,
  pickDirectory,
  startInstall,
} from "../api";
import type { DirCheck, SetupContext } from "../types";

/** How long the page waits after the directory changes before re-probing it. */
const RECHECK_DELAY_MS = 400;

export interface OptionsPageProps {
  context: SetupContext;
  /** Called once the backend accepted the install request. */
  onStarted: () => void;
  /** Closes the installer window. */
  onClose: () => void;
}

interface ActionError {
  message: string;
  detail: string | null;
}

export function OptionsPage({ context, onStarted, onClose }: OptionsPageProps) {
  const [dir, setDir] = useState(context.defaultDir);
  const [check, setCheck] = useState<DirCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [startMenuShortcut, setStartMenuShortcut] = useState(true);
  const [desktopShortcut, setDesktopShortcut] = useState(true);
  const [launchAfterInstall, setLaunchAfterInstall] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);

  const dirLabelId = useId();
  // The first probe runs immediately; later edits wait for the user to stop typing.
  const firstProbe = useRef(true);

  useEffect(() => {
    const target = dir.trim();
    if (!target) {
      setCheck(null);
      setCheckError(null);
      setChecking(false);
      return;
    }

    let active = true;
    // Drop the previous verdict immediately: it describes a directory the user left.
    setCheck(null);
    setCheckError(null);
    setChecking(true);

    const delay = firstProbe.current ? 0 : RECHECK_DELAY_MS;
    firstProbe.current = false;

    const timer = window.setTimeout(() => {
      checkDirectory(target)
        .then((result) => {
          if (active) {
            setCheck(result);
          }
        })
        .catch((failure: unknown) => {
          if (active) {
            setCheckError(errorMessage(failure));
          }
        })
        .finally(() => {
          if (active) {
            setChecking(false);
          }
        });
    }, delay);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [dir]);

  const required = context.extractedBytes;
  const usable = check !== null && check.writable && check.sufficientSpace;
  const ready = usable && dir.trim().length > 0 && !busy;

  const browse = useCallback(async () => {
    setError(null);
    try {
      const picked = await pickDirectory(dir);
      if (picked) {
        setDir(picked);
      }
    } catch (failure) {
      setError({ message: errorMessage(failure), detail: errorDetail(failure) });
    }
  }, [dir]);

  const reveal = useCallback(() => {
    const target = dir.trim();
    if (!target) {
      return;
    }
    setError(null);
    void openPath(target).catch((failure: unknown) => {
      setError({ message: errorMessage(failure), detail: errorDetail(failure) });
    });
  }, [dir]);

  const submit = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await startInstall({
        dir: dir.trim(),
        startMenuShortcut,
        desktopShortcut,
        launchAfterInstall,
      });
      // `busy` stays set on purpose: the page is about to be replaced by the progress
      // page, and a second click in between would queue a second install.
      onStarted();
    } catch (failure) {
      setError({ message: errorMessage(failure), detail: errorDetail(failure) });
      setBusy(false);
    }
  }, [dir, startMenuShortcut, desktopShortcut, launchAfterInstall, onStarted]);

  const problem =
    check && !usable
      ? [
          check.message,
          !check.writable ? "目标目录不可写。" : null,
          !check.sufficientSpace
            ? `可用空间 ${formatBytes(check.freeBytes)}，安装需要 ${formatBytes(required)}。`
            : null,
        ]
          .filter(Boolean)
          .join(" ")
      : null;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3.5">
        <img src="/icon.png" alt="" className="size-12 rounded-[var(--radius-lg)]" />
        <div className="min-w-0">
          <h1 className="text-title font-semibold tracking-[-0.016em] text-content">
            安装 {context.appName}
          </h1>
          <p className="mt-0.5 text-caption tabular-nums text-content-tertiary">
            版本 {context.appVersion}
          </p>
        </div>
      </header>

      <p className="text-label leading-[1.35rem] text-content-secondary">
        内置 yt-dlp 与 FFmpeg，安装后无需任何额外依赖
      </p>

      <Surface tone="panel" className="px-4 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <span id={dirLabelId} className="text-label font-medium text-content">
            安装位置
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              icon={<FolderOpen className="size-3.5" />}
              onClick={() => void browse()}
              disabled={busy}
            >
              浏览…
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<ExternalLink className="size-3.5" />}
              onClick={reveal}
              disabled={busy || dir.trim().length === 0}
            >
              打开目录
            </Button>
          </div>
        </div>

        <Tooltip label={dir} side="top">
          <div
            role="group"
            aria-labelledby={dirLabelId}
            className="field-input mt-2.5 flex h-9.5 items-center gap-2 px-3"
          >
            <HardDrive className="size-3.5 shrink-0 text-content-tertiary" aria-hidden />
            <span className="selectable min-w-0 flex-1 truncate font-mono text-label text-content">
              {shortenPath(dir)}
            </span>
          </div>
        </Tooltip>

        {/* `min-h` keeps the row height stable while the probe is in flight, so the
            panel below never jumps when a verdict arrives. */}
        <div className="mt-2 min-h-[1.15rem]" role="status">
          {checking ? (
            <span className="flex items-center gap-1.5 text-caption text-content-tertiary">
              <Spinner size={11} />
              正在检查目标目录…
            </span>
          ) : problem ? (
            <span className="flex items-start gap-1.5 text-caption leading-[1.15rem] text-warning">
              <AlertTriangle className="mt-px size-3.5 shrink-0" strokeWidth={2} aria-hidden />
              <span className="min-w-0">{problem}</span>
            </span>
          ) : check ? (
            <span className="flex items-start gap-1.5 text-caption leading-[1.15rem] text-content-tertiary">
              <Check className="mt-px size-3.5 shrink-0 text-success" strokeWidth={2.6} aria-hidden />
              <span className="min-w-0">
                可用空间 {formatBytes(check.freeBytes)}，安装需要 {formatBytes(required)}
                {check.exists ? "" : "，目录不存在时将自动创建"}
              </span>
            </span>
          ) : checkError ? (
            <span className="text-caption text-danger">{checkError}</span>
          ) : null}
        </div>
      </Surface>

      {/* Rows carry the padding, not the panel, so the hairlines run the full width —
          the same pattern the preferences list uses. */}
      <Surface tone="panel" className="divide-y divide-line-subtle">
        <Field
          orientation="horizontal"
          label="创建开始菜单快捷方式"
          className="px-4 py-2.5"
        >
          <Switch
            checked={startMenuShortcut}
            onCheckedChange={setStartMenuShortcut}
            disabled={busy}
            label="创建开始菜单快捷方式"
          />
        </Field>
        <Field orientation="horizontal" label="创建桌面快捷方式" className="px-4 py-2.5">
          <Switch
            checked={desktopShortcut}
            onCheckedChange={setDesktopShortcut}
            disabled={busy}
            label="创建桌面快捷方式"
          />
        </Field>
        <Field
          orientation="horizontal"
          label={`安装完成后启动 ${context.appName}`}
          className="px-4 py-2.5"
        >
          <Switch
            checked={launchAfterInstall}
            onCheckedChange={setLaunchAfterInstall}
            disabled={busy}
            label={`安装完成后启动 ${context.appName}`}
          />
        </Field>
      </Surface>

      <Surface tone="panel" className="grid grid-cols-3 gap-4 px-4 py-3">
        <MetaItem label="安装大小" value={formatBytes(required)} />
        <MetaItem
          label="内置运行库"
          value={context.hasBundledRuntime ? "完整 FFmpeg 运行库" : "—"}
        />
        <MetaItem label="文件数" value={context.payloadFiles.toLocaleString("zh-CN")} />
      </Surface>

      {error ? <ActionErrorPanel error={error} /> : null}

      <div className="flex items-center gap-2.5 pt-0.5">
        <Button
          variant="primary"
          size="lg"
          icon={<Download className="size-4" />}
          loading={busy}
          disabled={!ready}
          onClick={() => void submit()}
          className="flex-1"
        >
          安装
        </Button>
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>
          取消
        </Button>
      </div>
    </div>
  );
}

/** Inline failure notice for the actions on this page. */
function ActionErrorPanel({ error }: { error: ActionError }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-start gap-1.5 text-caption leading-[1.15rem] text-danger">
        <AlertTriangle className="mt-px size-3.5 shrink-0" strokeWidth={2} aria-hidden />
        <span className="min-w-0">{error.message}</span>
      </p>
      {error.detail ? (
        <pre className="selectable max-h-40 overflow-auto rounded-[var(--radius-sm)] border border-line bg-surface-sunken p-2 font-mono text-micro leading-[1.05rem] whitespace-pre-wrap text-content-tertiary">
          {error.detail}
        </pre>
      ) : null}
    </div>
  );
}
