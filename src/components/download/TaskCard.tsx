/**
 * One task in the download queue.
 *
 * The queue re-renders on every progress event (roughly five per second), so the card
 * is memoised: it re-renders only when its own task object changes. Every action goes
 * through `getState()` instead of a hook, so nothing inside a card can widen the
 * subscription and drag the rest of the list into a progress tick.
 */

import { motion, useReducedMotion } from "framer-motion";
import {
  Check,
  CircleSlash,
  Copy,
  Download,
  Ellipsis,
  FilePlay,
  Film,
  FolderOpen,
  Gauge,
  GitMerge,
  Hourglass,
  Info,
  ListVideo,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Timer,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { Fragment, memo, useState, type ReactNode } from "react";

import * as runtimeApi from "@/api/runtime";
import { Button, IconButton } from "@/components/ui/Button";
import { Menu, MenuItem, MenuSeparator, Tooltip } from "@/components/ui/Overlay";
import { AnimatedNumber, ProgressBar } from "@/components/ui/Progress";
import { Badge, type BadgeTone } from "@/components/ui/Surface";
import { cn } from "@/lib/cn";
import {
  containerLabel,
  formatBytes,
  formatDuration,
  formatEta,
  formatPercent,
  formatRelative,
  formatSpeed,
  shortenPath,
} from "@/lib/format";
import { itemVariants } from "@/lib/motion";
import { useExpertMode } from "@/stores/settings";
import { useTasksStore } from "@/stores/tasks";
import { toast } from "@/stores/toasts";
import { useUiStore } from "@/stores/ui";
import type {
  DownloadTask,
  FormatSelection,
  StreamProgress,
  TaskState,
} from "@/types/models";

/* -------------------------------------------------------------------------- */
/* Task vocabulary                                                            */
/* -------------------------------------------------------------------------- */

const STATE_META: Record<TaskState, { label: string; tone: BadgeTone }> = {
  queued: { label: "等待中", tone: "neutral" },
  probing: { label: "解析中", tone: "info" },
  downloading: { label: "下载中", tone: "accent" },
  merging: { label: "合并中", tone: "info" },
  completed: { label: "已完成", tone: "success" },
  paused: { label: "已暂停", tone: "warning" },
  cancelled: { label: "已取消", tone: "neutral" },
  failed: { label: "失败", tone: "danger" },
};

const ROLE_LABELS: Record<StreamProgress["role"], string> = {
  video: "视频",
  audio: "音频",
  single: "文件",
};

const percentText = (value: number): string => formatPercent(value);

function isActiveState(state: TaskState): boolean {
  return state === "probing" || state === "downloading" || state === "merging";
}

function stageIcon(state: TaskState): LucideIcon {
  if (state === "merging") {
    return GitMerge;
  }
  if (state === "probing") {
    return Search;
  }
  if (state === "paused") {
    return Pause;
  }
  return Download;
}

/** yt-dlp reports codecs as ids such as `avc1.640028`; short names read better. */
function codecLabel(codec: string | null | undefined): string | null {
  if (!codec) {
    return null;
  }
  const value = codec.toLowerCase();
  if (value.startsWith("avc") || value === "h264" || value === "h.264") {
    return "H.264";
  }
  if (value.startsWith("av01") || value === "av1") {
    return "AV1";
  }
  if (value.startsWith("vp09") || value === "vp9") {
    return "VP9";
  }
  if (value.startsWith("vp8")) {
    return "VP8";
  }
  if (value.startsWith("hev") || value.startsWith("hvc") || value === "h265") {
    return "HEVC";
  }
  if (value.startsWith("opus")) {
    return "Opus";
  }
  if (value.startsWith("mp4a") || value.startsWith("aac")) {
    return "AAC";
  }
  if (value.startsWith("vorbis")) {
    return "Vorbis";
  }
  return codec;
}

/** 0 – 1 when the stream reports a size; `null` when it is still unknown. */
function streamRatio(stream: StreamProgress): number | null {
  if (stream.finished) {
    return 1;
  }
  if (!stream.totalBytes || stream.totalBytes <= 0) {
    return null;
  }
  return Math.max(0, Math.min(1, stream.downloadedBytes / stream.totalBytes));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------- */
/* Small pieces                                                               */
/* -------------------------------------------------------------------------- */

/** Format summary chip. Deliberately not a table: one line, wraps if needed. */
function Chip({
  children,
  tone = "neutral",
  icon,
  dot = false,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  icon?: ReactNode;
  dot?: boolean;
}) {
  return (
    <Badge tone={tone} icon={icon} dot={dot} className="gap-1 px-1.5 py-0">
      {children}
    </Badge>
  );
}

function Hint({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-micro text-content-tertiary">
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{children}</span>
    </p>
  );
}

/** `视频 1080p ✓ · 音频 Opus 45%` — one item per stream of a split download. */
function StreamItem({
  stream,
  selection,
}: {
  stream: StreamProgress;
  selection: FormatSelection;
}) {
  const ratio = streamRatio(stream);
  const detail =
    stream.role === "video"
      ? selection.height !== null
        ? `${selection.height}p`
        : containerLabel(stream.ext)
      : stream.role === "audio"
        ? (codecLabel(selection.audioCodec) ?? containerLabel(stream.ext))
        : containerLabel(stream.ext);

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="shrink-0 text-content-secondary">{ROLE_LABELS[stream.role]}</span>
      <span className="truncate">{detail}</span>
      {stream.finished ? (
        <Check
          role="img"
          aria-label="已完成"
          className="size-3 shrink-0 text-success"
        />
      ) : ratio !== null ? (
        <span className="shrink-0 tabular-nums">{Math.round(ratio * 100)}%</span>
      ) : null}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Card                                                                       */
/* -------------------------------------------------------------------------- */

export interface TaskCardProps {
  task: DownloadTask;
  /** Overrides the built-in "open file" action, for reuse outside the queue. */
  onOpenFile?: (task: DownloadTask) => void;
}

function TaskCardBase({ task, onOpenFile }: TaskCardProps) {
  const reduce = useReducedMotion();
  const expert = useExpertMode();
  const [thumbnailBroken, setThumbnailBroken] = useState(false);

  const { progress, selection, output, error } = task;
  const active = isActiveState(task.state);
  const meta = STATE_META[task.state];
  const done = task.state === "completed" && output !== null;
  const showProgress = active || task.state === "paused";
  const totalKnown = progress.totalBytes !== null && progress.totalBytes > 0;
  // A denominator we do not have yet cannot be turned into a fill level, so the bar
  // sweeps rather than inventing a percentage.
  const barValue = progress.percent > 0 || totalKnown ? progress.percent : null;
  const StageIcon = stageIcon(task.state);
  const stage = progress.stage.trim().length > 0 ? progress.stage.trim() : meta.label;
  const thumbnail = thumbnailBroken ? null : task.thumbnail;
  const videoCodec = codecLabel(selection.videoCodec);
  const audioCodec = codecLabel(selection.audioCodec);
  const rawCommand = task.commandPreview ?? error?.command ?? null;

  const pause = () => {
    void useTasksStore.getState().pause(task.id);
  };

  const resume = () => {
    void useTasksStore.getState().resume(task.id);
  };

  const retry = () => {
    void useTasksStore.getState().retry(task.id);
  };

  const remove = (deleteFiles: boolean) => {
    void useTasksStore.getState().remove(task.id, deleteFiles);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(task.url);
      toast.success("已复制下载链接");
    } catch (cause) {
      toast.error("复制失败", message(cause));
    }
  };

  const confirmCancel = () => {
    useUiStore.getState().openConfirm({
      title: "取消这个下载？",
      description: `“${task.title}”会立即停止，已下载的临时文件将被删除。`,
      confirmLabel: "取消下载",
      cancelLabel: "继续下载",
      danger: true,
      onConfirm: () => useTasksStore.getState().cancel(task.id),
    });
  };

  const confirmRedownload = () => {
    useUiStore.getState().openConfirm({
      title: "重新下载？",
      description: "将从零开始重新下载，已下载的临时文件会被删除。",
      confirmLabel: "重新下载",
      danger: true,
      onConfirm: () => useTasksStore.getState().retry(task.id, true),
    });
  };

  const confirmRemoveWithFiles = () => {
    const file = output?.fileName;
    useUiStore.getState().openConfirm({
      title: "移除任务并删除文件？",
      description: file
        ? `“${file}”会从磁盘上永久删除，任务记录也会从队列中移除。`
        : "任务记录会从队列中移除，已下载的临时文件会一并删除。",
      confirmLabel: "删除",
      danger: true,
      onConfirm: () => useTasksStore.getState().remove(task.id, true),
    });
  };

  const openFile = async () => {
    if (onOpenFile) {
      onOpenFile(task);
      return;
    }
    const path = output?.filePath;
    if (!path) {
      toast.warning("还没有可打开的文件");
      return;
    }
    try {
      await runtimeApi.openPath(path);
    } catch (cause) {
      toast.error("无法打开文件", message(cause));
    }
  };

  const revealFile = async () => {
    const path = output?.filePath ?? output?.directory;
    if (!path) {
      toast.warning("还没有可定位的文件");
      return;
    }
    try {
      await runtimeApi.revealPath(path);
    } catch (cause) {
      toast.error("无法定位文件", message(cause));
    }
  };

  return (
    <motion.article
      variants={reduce ? undefined : itemVariants}
      initial={reduce ? false : undefined}
      className={cn(
        "panel relative flex flex-col gap-3 p-3.5 transition-colors",
        done ? "border-success/30" : "hover:border-line-strong",
        task.state === "failed" && "border-danger/30",
        task.state === "cancelled" && "opacity-75",
      )}
    >
      {done ? (
        <span
          aria-hidden
          className="absolute inset-y-3.5 left-0 w-[3px] rounded-full bg-success"
        />
      ) : null}

      {/* Thumbnail, title, format summary and the action group ----------------- */}
      <div className="flex min-w-0 items-start gap-3.5">
        <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-[var(--radius-sm)] border border-line-subtle bg-surface-sunken">
          {thumbnail ? (
            <img
              src={thumbnail}
              alt=""
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setThumbnailBroken(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-content-tertiary">
              <Film className="size-5" strokeWidth={1.7} />
            </span>
          )}
          {task.duration !== null ? (
            <span className="absolute right-1 bottom-1 rounded-[var(--radius-xs)] bg-surface-sunken/85 px-1 text-micro tabular-nums text-content-secondary">
              {formatDuration(task.duration)}
            </span>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h3
            className="line-clamp-2 text-label leading-[1.2rem] font-medium text-content"
            title={task.title}
          >
            {task.title}
          </h3>

          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-micro text-content-tertiary">
            <span className="max-w-[14rem] truncate" title={task.uploader ?? undefined}>
              {task.uploader ?? "未知作者"}
            </span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{formatRelative(task.createdAt)}</span>
            {task.attempts > 1 ? (
              <>
                <span aria-hidden>·</span>
                <span>第 {task.attempts} 次尝试</span>
              </>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {selection.height !== null ? <Chip>{`${selection.height}p`}</Chip> : null}
            {selection.fps !== null && selection.fps >= 50 ? (
              <Chip>{`${Math.round(selection.fps)}fps`}</Chip>
            ) : null}
            {videoCodec ? <Chip>{videoCodec}</Chip> : null}
            {audioCodec ? <Chip>{audioCodec}</Chip> : null}
            <Chip>{containerLabel(selection.container)}</Chip>
            {selection.hdr ? (
              <Chip tone="info" dot>
                HDR
              </Chip>
            ) : null}
            {/* The finished card shows the real size below, so the estimate would be noise. */}
            {!done && selection.sizeBytes !== null ? (
              <Chip>约 {formatBytes(selection.sizeBytes)}</Chip>
            ) : null}
            {task.playlistCount !== null && task.playlistIndex !== null ? (
              <Chip icon={<ListVideo className="size-3" />}>
                {task.playlistIndex + 1}/{task.playlistCount}
              </Chip>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          <Badge tone={meta.tone} dot={active} className="mr-0.5">
            {meta.label}
          </Badge>

          {active ? (
            <>
              <Tooltip label="暂停下载">
                <IconButton label="暂停下载" onClick={pause}>
                  <Pause className="size-4" />
                </IconButton>
              </Tooltip>
              <Tooltip label="取消下载">
                <IconButton label="取消下载" variant="danger" onClick={confirmCancel}>
                  <X className="size-4" />
                </IconButton>
              </Tooltip>
            </>
          ) : null}

          {task.state === "queued" ? (
            <Tooltip label="取消下载">
              <IconButton label="取消下载" variant="danger" onClick={confirmCancel}>
                <X className="size-4" />
              </IconButton>
            </Tooltip>
          ) : null}

          {task.state === "paused" ? (
            <>
              <Tooltip label="继续下载">
                <IconButton label="继续下载" onClick={resume}>
                  <Play className="size-4" />
                </IconButton>
              </Tooltip>
              <Tooltip label="取消下载">
                <IconButton label="取消下载" variant="danger" onClick={confirmCancel}>
                  <X className="size-4" />
                </IconButton>
              </Tooltip>
              <Tooltip label="移除任务">
                <IconButton
                  label="移除任务"
                  variant="danger"
                  onClick={() => remove(false)}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </Tooltip>
            </>
          ) : null}

          {task.state === "failed" ? (
            <>
              <Tooltip label="重试下载">
                <IconButton label="重试下载" onClick={retry}>
                  <RotateCcw className="size-4" />
                </IconButton>
              </Tooltip>
              <Tooltip label="重新下载（删除已下载的部分）">
                <IconButton label="重新下载" onClick={confirmRedownload}>
                  <RefreshCw className="size-4" />
                </IconButton>
              </Tooltip>
              <Tooltip label="移除任务">
                <IconButton
                  label="移除任务"
                  variant="danger"
                  onClick={() => remove(false)}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </Tooltip>
            </>
          ) : null}

          {task.state === "cancelled" ? (
            <Tooltip label="重试下载">
              <IconButton label="重试下载" onClick={retry}>
                <RotateCcw className="size-4" />
              </IconButton>
            </Tooltip>
          ) : null}

          {done ? (
            <>
              <Tooltip label="打开文件">
                <IconButton label="打开文件" onClick={() => void openFile()}>
                  <FilePlay className="size-4" />
                </IconButton>
              </Tooltip>
              <Tooltip label="打开所在文件夹">
                <IconButton label="打开所在文件夹" onClick={() => void revealFile()}>
                  <FolderOpen className="size-4" />
                </IconButton>
              </Tooltip>
              <Tooltip label="重新下载（删除已下载的文件）">
                <IconButton label="重新下载" onClick={confirmRedownload}>
                  <RefreshCw className="size-4" />
                </IconButton>
              </Tooltip>
            </>
          ) : null}

          <Menu
            trigger={
              <IconButton label="更多操作">
                <Ellipsis className="size-4" />
              </IconButton>
            }
          >
            <MenuItem icon={<Copy className="size-3.5" />} onSelect={() => void copyLink()}>
              复制链接
            </MenuItem>
            {task.state === "completed" ? (
              <MenuItem
                icon={<RefreshCw className="size-3.5" />}
                onSelect={confirmRedownload}
              >
                重新下载
              </MenuItem>
            ) : null}
            {task.state === "failed" ? (
              <MenuItem
                icon={<RefreshCw className="size-3.5" />}
                onSelect={confirmRedownload}
              >
                重新下载（从零开始）
              </MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuItem
              icon={<Trash2 className="size-3.5" />}
              onSelect={() => remove(false)}
            >
              移除任务
            </MenuItem>
            <MenuItem
              danger
              icon={<Trash2 className="size-3.5" />}
              onSelect={confirmRemoveWithFiles}
            >
              移除并删除文件
            </MenuItem>
          </Menu>
        </div>
      </div>

      {/* Progress ------------------------------------------------------------- */}
      {showProgress ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-micro font-medium text-content-secondary">
              <StageIcon className="size-3.5 shrink-0" />
              <span className="truncate">{stage}</span>
            </span>
            <span className="shrink-0 text-micro font-semibold text-content">
              <AnimatedNumber value={progress.percent} format={percentText} />
            </span>
            <span className="shrink-0 text-micro tabular-nums text-content-tertiary">
              {formatBytes(progress.downloadedBytes)} /{" "}
              {totalKnown ? formatBytes(progress.totalBytes) : "未知大小"}
            </span>
            {progress.speed !== null && progress.speed > 0 ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-micro tabular-nums text-content-tertiary">
                <Gauge className="size-3" />
                {formatSpeed(progress.speed)}
              </span>
            ) : null}
            {progress.eta !== null ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-micro tabular-nums text-content-tertiary">
                <Timer className="size-3" />
                剩余 {formatEta(progress.eta)}
              </span>
            ) : null}
          </div>

          <ProgressBar
            value={barValue}
            height={6}
            tone={task.state === "paused" ? "warning" : "accent"}
          />

          {task.streams.length > 1 ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-content-tertiary">
              {task.streams.map((stream, index) => (
                <Fragment key={`${stream.role}-${stream.formatId}`}>
                  {index > 0 ? (
                    <span aria-hidden className="text-content-tertiary/70">
                      ·
                    </span>
                  ) : null}
                  <StreamItem stream={stream} selection={selection} />
                </Fragment>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {task.state === "queued" ? (
        <Hint icon={Hourglass}>已进入队列，等待空闲下载槽位</Hint>
      ) : null}

      {task.state === "cancelled" ? (
        <Hint icon={CircleSlash}>任务已取消，可以重试或移除</Hint>
      ) : null}

      {/* The honest recovery path when only the mux step failed. ---------------- */}
      {task.mergeReady ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-md)] border border-warning/30 bg-warning-soft px-3 py-2.5">
          <GitMerge className="size-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <p className="text-label font-medium text-content">
              视频与音频都已下载完成，只差合并这一步
            </p>
            <p className="text-micro text-content-tertiary">
              只重试合并，不会重新下载任何内容。
            </p>
          </div>
          <Button
            size="xs"
            variant="primary"
            icon={<GitMerge className="size-3.5" />}
            onClick={() => void useTasksStore.getState().retryMerge(task.id)}
          >
            只重试合并
          </Button>
        </div>
      ) : null}

      {/* Result --------------------------------------------------------------- */}
      {done && output ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[var(--radius-md)] border border-success/25 bg-success-soft px-3 py-2">
            <FilePlay className="size-4 shrink-0 text-success" />
            <span
              className="min-w-0 flex-1 truncate text-label font-medium text-content"
              title={output.filePath}
            >
              {output.fileName}
            </span>
            <span className="shrink-0 text-micro font-medium tabular-nums text-content-secondary">
              {formatBytes(output.sizeBytes)}
            </span>
            <Badge tone="success">{containerLabel(output.container)}</Badge>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-micro text-content-tertiary">
            <FolderOpen className="size-3 shrink-0" />
            <span className="min-w-0 truncate" title={output.directory}>
              {shortenPath(output.directory)}
            </span>
            {task.finishedAt ? (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums">{formatRelative(task.finishedAt)}</span>
              </>
            ) : null}
          </div>
          {expert && output.mergedFrom.length > 0 ? (
            <p
              className="selectable truncate font-mono text-micro text-content-tertiary"
              title={output.mergedFrom.join("\n")}
            >
              合并来源: {output.mergedFrom.join("  +  ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Failure -------------------------------------------------------------- */}
      {error ? (
        <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-danger/30 bg-danger-soft px-3 py-2.5">
          <div className="flex min-w-0 items-start gap-2">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" />
            <div className="min-w-0 flex-1">
              <p className="text-label leading-[1.1rem] font-medium text-content">
                {error.summary}
              </p>
              {/* Actionable guidance is user copy, never hidden behind Expert Mode. */}
              {error.hint ? (
                <p className="mt-1 text-caption leading-[1.05rem] text-content-secondary">
                  {error.hint}
                </p>
              ) : null}
              {expert ? (
                <p className="mt-0.5 text-micro text-content-tertiary">
                  {error.kind}
                  {error.exitCode !== null ? ` · 退出码 ${error.exitCode}` : ""}
                </p>
              ) : null}
            </div>
          </div>
          {/* Raw diagnostics stay behind Expert Mode — they are not user copy. */}
          {expert && (error.detail || rawCommand) ? (
            <pre className="selectable max-h-40 overflow-auto rounded-[var(--radius-sm)] border border-line bg-surface-sunken p-2 font-mono text-micro leading-[1.05rem] whitespace-pre-wrap text-content-tertiary">
              {[error.detail, rawCommand]
                .filter((part): part is string => Boolean(part))
                .join("\n\n")}
            </pre>
          ) : null}
        </div>
      ) : null}

      {expert && !error && task.commandPreview ? (
        <p
          className="selectable truncate font-mono text-micro text-content-tertiary"
          title={task.commandPreview}
        >
          $ {task.commandPreview}
        </p>
      ) : null}

      {/* Notices: de-emphasised, at most the two most recent. ------------------ */}
      {task.notices.length > 0 ? (
        <div className="flex flex-col gap-1">
          {task.notices.slice(-2).map((notice, index) => (
            <p
              key={`${index}-${notice}`}
              className="flex min-w-0 items-center gap-1.5 text-micro text-content-tertiary"
              title={notice}
            >
              <Info className="size-3 shrink-0" />
              <span className="truncate">{notice}</span>
            </p>
          ))}
        </div>
      ) : null}
    </motion.article>
  );
}

/**
 * Memoised on purpose: the queue re-renders on every progress event, and only the
 * card whose `task` object changed should re-render with it.
 */
export const TaskCard = memo(TaskCardBase);
