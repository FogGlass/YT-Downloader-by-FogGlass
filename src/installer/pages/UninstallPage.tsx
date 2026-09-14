/**
 * The uninstall entry page — the only screen shown before an uninstall runs.
 *
 * Both destructive options start off: the default behaviour removes the application and
 * keeps every byte of user data, and the page says so in plain language before offering
 * the single destructive action.
 */

import { AlertTriangle, HardDrive, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useId, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Controls";
import { Surface } from "@/components/ui/Surface";
import { shortenPath } from "@/lib/format";
import { errorDetail, errorMessage, startUninstall } from "../api";
import type { SetupContext } from "../types";

export interface UninstallPageProps {
  context: SetupContext;
  /** Called once the backend accepted the uninstall request. */
  onStarted: () => void;
  /** Closes the installer window. */
  onClose: () => void;
}

interface ActionError {
  message: string;
  detail: string | null;
}

export function UninstallPage({ context, onStarted, onClose }: UninstallPageProps) {
  // Both default to off: removing user data is never the implied choice.
  const [removeAppData, setRemoveAppData] = useState(false);
  const [removeDownloads, setRemoveDownloads] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);

  const dirLabelId = useId();
  const installDir = context.installDir ?? context.defaultDir;

  const submit = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await startUninstall({ removeAppData, removeDownloads });
      // Keep `busy` set: the window is about to show the progress page.
      onStarted();
    } catch (failure) {
      setError({ message: errorMessage(failure), detail: errorDetail(failure) });
      setBusy(false);
    }
  }, [removeAppData, removeDownloads, onStarted]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3.5">
        <img src="/icon.png" alt="" className="size-12 rounded-[var(--radius-lg)]" />
        <div className="min-w-0">
          <h1 className="text-title font-semibold tracking-[-0.016em] text-content">
            卸载 {context.appName}
          </h1>
          <p className="mt-0.5 text-caption tabular-nums text-content-tertiary">
            {context.installedVersion
              ? `已安装版本 ${context.installedVersion}`
              : "将从本机移除此应用"}
          </p>
        </div>
      </header>

      <p className="text-label leading-[1.35rem] text-content-secondary">
        将移除 {context.appName} 及其内置的 yt-dlp 与 FFmpeg 运行库。
      </p>

      <Surface tone="panel" className="px-4 py-3.5">
        <span id={dirLabelId} className="block text-label font-medium text-content">
          安装位置
        </span>
        <div
          role="group"
          aria-labelledby={dirLabelId}
          className="field-input mt-2.5 flex h-9.5 items-center gap-2 px-3"
        >
          <HardDrive className="size-3.5 shrink-0 text-content-tertiary" aria-hidden />
          <span className="selectable min-w-0 flex-1 truncate font-mono text-label text-content" title={installDir}>
            {shortenPath(installDir)}
          </span>
        </div>
      </Surface>

      <p className="flex items-start gap-2 rounded-[var(--radius-md)] border border-line bg-surface-muted px-3 py-2.5 text-caption leading-[1.15rem] text-content-secondary">
        <ShieldCheck className="mt-px size-3.5 shrink-0 text-success" strokeWidth={2} aria-hidden />
        <span className="min-w-0">
          默认不会删除任何用户数据：应用设置、下载历史、收藏与已下载的视频文件都会保留。
        </span>
      </p>

      <Surface tone="panel" className="divide-y divide-line-subtle">
        <div className="px-4 py-3">
          <Checkbox
            checked={removeAppData}
            onCheckedChange={setRemoveAppData}
            disabled={busy}
            label="同时删除应用设置、下载历史与收藏"
            description={
              "位于安装目录的 data\\config、history、favorites、logs、cache、temp"
            }
          />
        </div>
        <div className="px-4 py-3">
          <Checkbox
            checked={removeDownloads}
            onCheckedChange={setRemoveDownloads}
            disabled={busy}
            // The danger tone has to live in the label: `Checkbox` renders its
            // `description` in the tertiary tone, which is too quiet for a destructive act.
            label={
              <>
                <span>同时删除已下载的视频文件</span>
                <span className="mt-0.5 block text-caption text-danger">
                  将删除下载目录中的全部视频文件，此操作无法撤销。
                </span>
              </>
            }
          />
        </div>
      </Surface>

      {removeDownloads ? (
        <p className="flex items-start gap-1.5 text-caption leading-[1.15rem] text-danger">
          <AlertTriangle className="mt-px size-3.5 shrink-0" strokeWidth={2} aria-hidden />
          <span className="min-w-0">已选择删除已下载的视频文件，卸载完成后无法恢复。</span>
        </p>
      ) : null}

      {error ? (
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
      ) : null}

      <div className="flex items-center gap-2.5 pt-0.5">
        <Button
          variant="danger"
          size="lg"
          icon={<Trash2 className="size-4" />}
          loading={busy}
          onClick={() => void submit()}
          className="flex-1"
        >
          卸载
        </Button>
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>
          取消
        </Button>
      </div>
    </div>
  );
}
