/**
 * About.
 *
 * Everything on this page is read from the backend: the version and build come from
 * `app_info`, the tool rows from a real `runtime_status` probe, and the paths from
 * `storage_info`. Nothing here is a static claim about the environment — if a tool is
 * missing, this page says so.
 */

import {
  AlertTriangle,
  Boxes,
  Cpu,
  FileSearch,
  FolderOpen,
  HardDrive,
  Keyboard,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";

import { IpcError } from "@/api/client";
import * as runtimeApi from "@/api/runtime";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState, ErrorState, Kbd } from "@/components/ui/Feedback";
import { Tooltip } from "@/components/ui/Overlay";
import { Skeleton } from "@/components/ui/Progress";
import { Badge, MetaItem, StatusDot } from "@/components/ui/Surface";
import { cn } from "@/lib/cn";
import { formatBytes, formatRelative } from "@/lib/format";
import { useSettingsStore } from "@/stores/settings";
import { toast } from "@/stores/toasts";
import type { RuntimeStatus, StorageInfo, ToolStatus } from "@/types/models";

/* -------------------------------------------------------------------------- */
/* Static descriptions (labels only — every value comes from the backend)     */
/* -------------------------------------------------------------------------- */

const TOOLS: { key: "ytDlp" | "ffmpeg" | "ffprobe"; label: string }[] = [
  { key: "ytDlp", label: "yt-dlp" },
  { key: "ffmpeg", label: "FFmpeg" },
  { key: "ffprobe", label: "FFprobe" },
];

const SOURCE_LABELS: Record<string, string> = {
  bundled: "随程序内置",
  configured: "手动指定",
  development: "开发目录",
  missing: "未找到",
};

const MODE_LABELS: Record<string, string> = {
  executable: "可执行文件",
  pythonModule: "Python 模块",
};

const STORAGE_ROWS: {
  key: Exclude<keyof StorageInfo, "logSizeBytes">;
  label: string;
  kind: "dir" | "file";
}[] = [
  { key: "root", label: "数据根目录", kind: "dir" },
  { key: "settingsFile", label: "设置文件", kind: "file" },
  { key: "historyFile", label: "下载历史", kind: "file" },
  { key: "favoritesFile", label: "收藏", kind: "file" },
  { key: "logFile", label: "日志文件", kind: "file" },
  { key: "tempDir", label: "临时目录", kind: "dir" },
  { key: "cacheDir", label: "缓存目录", kind: "dir" },
  { key: "downloadDir", label: "下载目录", kind: "dir" },
];

const SECURITY_LINES = [
  "Cookie 与链接不会被上传：解析和下载请求都由本机直接发往目标站点。",
  "不支持也不协助绕过 DRM、付费墙或访问控制。",
  "请仅下载你有权访问的内容，并遵守目标站点的服务条款。",
];

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["Ctrl", "N"], label: "新建下载" },
  { keys: ["Ctrl", "V"], label: "粘贴链接" },
  { keys: ["Ctrl", "L"], label: "聚焦链接框" },
  { keys: ["Ctrl", "Enter"], label: "解析" },
  { keys: ["Ctrl", "1 – 6"], label: "切换页面" },
  { keys: ["Ctrl", ","], label: "设置" },
];

const COMPONENTS = ["yt-dlp", "FFmpeg", "Tauri 2", "React"];

const describeError = (error: unknown): string =>
  error instanceof IpcError ? error.message : String(error);

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export function AboutPage() {
  const loading = useSettingsStore((state) => state.loading);
  const info = useSettingsStore((state) => state.info);
  const runtime = useSettingsStore((state) => state.runtime);
  const storage = useSettingsStore((state) => state.storage);
  const error = useSettingsStore((state) => state.error);
  const load = useSettingsStore((state) => state.load);
  const refreshRuntime = useSettingsStore((state) => state.refreshRuntime);
  const refreshStorage = useSettingsStore((state) => state.refreshStorage);
  const [checking, setChecking] = useState(false);

  // The log size and the download directory can change while the app runs.
  useEffect(() => {
    void refreshStorage();
  }, [refreshStorage]);

  const check = async () => {
    setChecking(true);
    try {
      await refreshRuntime();
      await refreshStorage();
      toast.success("运行库状态已更新");
    } finally {
      setChecking(false);
    }
  };

  if (loading) {
    return <AboutSkeleton />;
  }

  if (!info && !runtime && !storage) {
    return (
      <div className="flex h-full items-start justify-center pt-10">
        <ErrorState
          title="无法读取运行信息"
          description={error ?? "后端没有返回版本或运行库数据。"}
          onRetry={() => void load()}
        />
      </div>
    );
  }

  const profileLabel =
    info?.buildProfile === "release"
      ? "发布版"
      : info?.buildProfile === "debug"
        ? "调试版"
        : (info?.buildProfile ?? "—");

  const runtimeLabel = runtime
    ? runtime.complete
      ? "运行库就绪"
      : "运行库不完整"
    : "尚未检测";
  const runtimeTone = runtime ? (runtime.complete ? "success" : "warning") : "neutral";

  const openDirectory = async (path: string, label: string) => {
    try {
      await runtimeApi.openFolder(path);
    } catch (caught) {
      toast.error(`无法打开${label}`, describeError(caught));
    }
  };

  const revealFile = async (path: string, label: string) => {
    try {
      await runtimeApi.revealPath(path);
    } catch (caught) {
      toast.error(`无法显示${label}`, describeError(caught));
    }
  };

  const rootOnSystemDrive = /^c:/i.test(storage?.root.trim() ?? "");

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="flex flex-col gap-4 pb-1">
          {/* Hero ---------------------------------------------------------- */}
          <section className="panel flex flex-wrap items-center gap-5 p-5">
            <img
              src="/icon.png"
              alt=""
              className="size-16 shrink-0 rounded-[var(--radius-xl)] border border-line bg-surface-muted object-cover"
            />

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-title font-semibold tracking-[-0.016em] text-content">
                  YT Downloader
                </h1>
                <Badge tone="accent">v{info?.version ?? "—"}</Badge>
              </div>
              <p className="mt-1 text-label text-content-tertiary">
                基于 yt-dlp 与 FFmpeg 的桌面下载工作台
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <Badge tone="neutral" icon={<Cpu className="size-3" />}>
                  {profileLabel}
                </Badge>
                <Badge tone="neutral">{info?.target ?? "—"}</Badge>
                <Badge tone="neutral">Tauri {info?.tauriVersion ?? "—"}</Badge>
                <Badge tone={runtimeTone} dot>
                  {runtimeLabel}
                </Badge>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                icon={<RefreshCw className="size-3.5" />}
                loading={checking}
                onClick={() => void check()}
              >
                检查运行库
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<FolderOpen className="size-3.5" />}
                disabled={!storage}
                onClick={() => {
                  if (storage) {
                    void openDirectory(storage.root, "数据目录");
                  }
                }}
              >
                打开数据目录
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<FileSearch className="size-3.5" />}
                disabled={!storage}
                onClick={() => {
                  if (storage) {
                    void revealFile(storage.logFile, "日志文件");
                  }
                }}
              >
                打开日志
              </Button>
            </div>
          </section>

          {/* Runtime ------------------------------------------------------- */}
          <RuntimePanel runtime={runtime} onRecheck={() => void check()} checking={checking} />

          {/* Storage ------------------------------------------------------- */}
          <StoragePanel
            storage={storage}
            rootOnSystemDrive={rootOnSystemDrive}
            onOpen={(path, label) => void openDirectory(path, label)}
            onReveal={(path, label) => void revealFile(path, label)}
          />

          {/* Safety and shortcuts ------------------------------------------ */}
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="panel overflow-hidden">
              <header className="flex items-center gap-2.5 border-b border-line-subtle px-4 py-2.5">
                <ShieldCheck className="size-4 text-success" strokeWidth={1.9} />
                <h2 className="text-label font-semibold text-content">安全与合规</h2>
              </header>
              <ul className="flex flex-col gap-2.5 px-4 py-3.5">
                {SECURITY_LINES.map((line) => (
                  <li key={line} className="flex items-start gap-2.5">
                    <span
                      className="mt-[0.4375rem] size-1 shrink-0 rounded-full bg-content-tertiary"
                      aria-hidden
                    />
                    <span className="min-w-0 text-caption leading-[1.15rem] text-content-secondary">
                      {line}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="panel overflow-hidden">
              <header className="flex items-center gap-2.5 border-b border-line-subtle px-4 py-2.5">
                <Keyboard className="size-4 text-content-tertiary" strokeWidth={1.9} />
                <h2 className="text-label font-semibold text-content">快捷键</h2>
              </header>
              <ul className="divide-y divide-[color:var(--border-subtle)]">
                {SHORTCUTS.map((shortcut) => (
                  <li
                    key={shortcut.label}
                    className="flex items-center justify-between gap-4 px-4 py-2"
                  >
                    <span className="text-label text-content-secondary">{shortcut.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {shortcut.keys.map((key, index) => (
                        <span key={key} className="flex items-center gap-1">
                          {index > 0 ? (
                            <span className="text-micro text-content-tertiary">+</span>
                          ) : null}
                          <Kbd>{key}</Kbd>
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          {/* Open source --------------------------------------------------- */}
          <section className="panel flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
            <span className="flex items-center gap-2 text-label font-medium text-content">
              <Boxes className="size-4 text-content-tertiary" strokeWidth={1.9} />
              开源组件
            </span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-content-tertiary">
              {COMPONENTS.map((name, index) => (
                <span key={name} className="flex items-center gap-2">
                  {index > 0 ? <span aria-hidden>·</span> : null}
                  {name}
                </span>
              ))}
            </span>
          </section>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Runtime                                                                    */
/* -------------------------------------------------------------------------- */

function RuntimePanel({
  runtime,
  onRecheck,
  checking,
}: {
  runtime: RuntimeStatus | null;
  onRecheck: () => void;
  checking: boolean;
}) {
  const complete = runtime?.complete ?? false;

  return (
    <section
      className={cn("panel overflow-hidden", runtime && !complete && "border-warning/40")}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line-subtle px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <StatusDot
            tone={runtime ? (complete ? "success" : "warning") : "neutral"}
            pulse={runtime !== null && !complete}
          />
          <h2 className="text-label font-semibold text-content">运行库</h2>
          {runtime ? (
            <Badge tone={complete ? "success" : "warning"}>
              {complete ? "全部可用" : "存在缺失"}
            </Badge>
          ) : null}
        </div>
        {runtime ? (
          <span className="text-caption text-content-tertiary" title={runtime.checkedAt}>
            检测于 {formatRelative(runtime.checkedAt)}
          </span>
        ) : null}
      </header>

      {runtime ? (
        <>
          {!complete ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-subtle bg-warning-soft px-4 py-2.5">
              <p className="flex min-w-0 items-start gap-2 text-caption leading-[1.1rem] text-warning">
                <AlertTriangle className="mt-px size-3.5 shrink-0" strokeWidth={2} />
                <span>
                  {/* Single line on purpose: a JSX line break would render as a space. */}
                  运行库不完整，解析与下载都会失败。请把 yt-dlp、ffmpeg、ffprobe 放到运行库目录，或在「设置 → 高级」中指定位置。
                </span>
              </p>
              <Button
                size="xs"
                variant="secondary"
                icon={<RefreshCw className="size-3.5" />}
                loading={checking}
                onClick={onRecheck}
              >
                重新检测
              </Button>
            </div>
          ) : null}

          <div className="divide-y divide-[color:var(--border-subtle)]">
            {TOOLS.map((tool) => (
              <ToolRow key={tool.key} label={tool.label} tool={runtime[tool.key]} />
            ))}
          </div>

          <div className="grid grid-cols-2 gap-4 border-t border-line-subtle px-4 py-3 sm:grid-cols-5">
            <MetaItem label="运行库目录" value={runtime.binDir || "—"} />
            <MetaItem
              label="来源"
              value={SOURCE_LABELS[runtime.source] ?? runtime.source ?? "—"}
            />
            <MetaItem
              label="yt-dlp 模式"
              value={MODE_LABELS[runtime.ytDlpMode] ?? runtime.ytDlpMode ?? "—"}
            />
            {/* YouTube signature solving needs a JS engine; without one downloads
                stall with no progress, so its absence is stated plainly. */}
            <MetaItem
              label="JS 运行时"
              value={runtime.jsRuntime ?? "未检测到"}
            />
            <MetaItem label="检测时间" value={runtime.checkedAt || "—"} />
          </div>

          {runtime.warnings.length > 0 ? (
            <div className="flex flex-col gap-1.5 border-t border-line-subtle px-4 py-3">
              {runtime.warnings.map((warning, index) => (
                <p
                  key={`${index}-${warning}`}
                  className="flex items-start gap-2 text-caption leading-[1.1rem] text-warning"
                >
                  <AlertTriangle className="mt-px size-3.5 shrink-0" strokeWidth={2} />
                  <span className="min-w-0">{warning}</span>
                </p>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <EmptyState
          icon={RefreshCw}
          title="尚未检测运行库"
          description="运行一次检测即可看到 yt-dlp、FFmpeg 与 FFprobe 的实际版本和路径。"
          action={
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshCw className="size-3.5" />}
              loading={checking}
              onClick={onRecheck}
            >
              检查运行库
            </Button>
          }
        />
      )}
    </section>
  );
}

function ToolRow({ label, tool }: { label: string; tool: ToolStatus }) {
  const path = tool.path ?? "未找到可执行文件";

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <StatusDot tone={tool.available ? "success" : "danger"} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-label font-medium text-content">{label}</span>
          <span className="font-mono text-caption text-content-tertiary">
            {tool.version ?? "版本未知"}
          </span>
        </div>
        <Tooltip label={path}>
          <p className="mt-0.5 truncate font-mono text-caption text-content-tertiary">
            {path}
          </p>
        </Tooltip>
        {tool.error ? (
          <p className="mt-0.5 text-caption leading-[1.05rem] text-danger">{tool.error}</p>
        ) : null}
      </div>

      <Badge tone={tool.available ? "success" : "danger"}>
        {tool.available ? "可用" : "不可用"}
      </Badge>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                    */
/* -------------------------------------------------------------------------- */

function StoragePanel({
  storage,
  rootOnSystemDrive,
  onOpen,
  onReveal,
}: {
  storage: StorageInfo | null;
  rootOnSystemDrive: boolean;
  onOpen: (path: string, label: string) => void;
  onReveal: (path: string, label: string) => void;
}) {
  return (
    <section className="panel overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-line-subtle px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <HardDrive className="size-4 text-content-tertiary" strokeWidth={1.9} />
          <h2 className="text-label font-semibold text-content">数据位置</h2>
        </div>
        {storage ? (
          <span className="text-caption tabular-nums text-content-tertiary">
            日志 {formatBytes(storage.logSizeBytes)}
          </span>
        ) : null}
      </header>

      {storage ? (
        <>
          <div className="divide-y divide-[color:var(--border-subtle)]">
            {STORAGE_ROWS.map((row) => {
              const path = storage[row.key];
              const action = row.kind === "dir" ? "打开" : "显示";
              return (
                <div key={row.key} className="row-hover flex items-center gap-3 px-4 py-2.5">
                  <span className="w-24 shrink-0 text-label text-content-secondary">
                    {row.label}
                  </span>
                  <Tooltip label={path}>
                    <span className="min-w-0 flex-1 truncate font-mono text-caption text-content-tertiary">
                      {path || "—"}
                    </span>
                  </Tooltip>
                  {row.key === "logFile" ? (
                    <span className="shrink-0 text-caption tabular-nums text-content-tertiary">
                      {formatBytes(storage.logSizeBytes)}
                    </span>
                  ) : null}
                  <Tooltip label={`在文件管理器中${action}`}>
                    <IconButton
                      label={`${action}${row.label}`}
                      size="xs"
                      onClick={() =>
                        row.kind === "dir"
                          ? onOpen(path, row.label)
                          : onReveal(path, row.label)
                      }
                    >
                      <FolderOpen className="size-3.5" />
                    </IconButton>
                  </Tooltip>
                </div>
              );
            })}
          </div>

          <div className="border-t border-line-subtle px-4 py-3">
            <p className="text-caption leading-[1.15rem] text-content-tertiary">
              {/* One line: a JSX line break inside Chinese text would render a stray space. */}
              设置、历史、收藏、日志与临时文件都保存在程序自身所在的目录中，不写入用户目录、%APPDATA% 或系统临时文件夹；下载目录默认为同级目录下的 downloads。
            </p>
            {rootOnSystemDrive ? (
              <p className="mt-1.5 flex items-start gap-2 text-caption leading-[1.15rem] text-warning">
                <AlertTriangle className="mt-px size-3.5 shrink-0" strokeWidth={2} />
                <span>
                  当前程序位于系统盘（C:），因此数据目录也在 C: 盘。把整个程序目录移到其他分区即可避免。
                </span>
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <EmptyState
          icon={FolderOpen}
          title="无法读取数据位置"
          description="后端没有返回存储信息，稍后重试即可。"
        />
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Skeleton                                                                   */
/* -------------------------------------------------------------------------- */

function AboutSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="panel flex flex-wrap items-center gap-5 p-5">
        <Skeleton className="size-16" rounded="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <Skeleton className="h-5 w-52" />
          <Skeleton className="h-3.5 w-72" />
          <Skeleton className="h-4 w-64" rounded="full" />
        </div>
        <Skeleton className="h-8 w-32" />
      </div>

      {Array.from({ length: 2 }).map((_, panel) => (
        <div key={panel} className="panel overflow-hidden">
          <div className="border-b border-line-subtle px-4 py-3">
            <Skeleton className="h-4 w-32" />
          </div>
          <div className="flex flex-col gap-3 p-4">
            {Array.from({ length: 3 }).map((_, row) => (
              <Skeleton key={row} className="h-10" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
