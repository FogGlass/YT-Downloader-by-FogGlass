/**
 * History — the record of every finished download.
 *
 * The page is a projection of the library store, so filtering, searching and removal
 * can never disagree with the rest of the app. Everything that touches the disk is
 * gated on the record actually owning a file, and a disabled action always explains
 * itself in its tooltip instead of silently greying out.
 */

import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Copy,
  Download,
  Eraser,
  FileX2,
  Film,
  FolderOpen,
  History as HistoryIcon,
  Layers,
  MoreHorizontal,
  Play,
  RotateCcw,
  Search,
  SearchX,
  Trash2,
  User2,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { IpcError } from "@/api/client";
import { enqueueDownloads } from "@/api/downloads";
import { Button, IconButton } from "@/components/ui/Button";
import { SegmentedControl, TextInput, type Segment } from "@/components/ui/Controls";
import { EmptyState } from "@/components/ui/Feedback";
import { Menu, MenuItem, MenuSeparator, Tooltip } from "@/components/ui/Overlay";
import { Skeleton } from "@/components/ui/Progress";
import { Badge, MetaItem, SectionHeader, type BadgeTone } from "@/components/ui/Surface";
import {
  containerLabel,
  formatBytes,
  formatCount,
  formatDuration,
  formatRelative,
  shortenPath,
} from "@/lib/format";
import { duration, ease, itemVariants, listVariants } from "@/lib/motion";
import {
  selectVisibleHistory,
  totalDownloaded,
  useLibraryStore,
  type HistoryFilter,
} from "@/stores/library";
import { useSettingsStore } from "@/stores/settings";
import { toast } from "@/stores/toasts";
import { useUiStore } from "@/stores/ui";
import type { HistoryEntry, HistoryStatus } from "@/types/models";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

const STATUS_META: Record<
  HistoryStatus,
  { label: string; tone: BadgeTone; icon: LucideIcon }
> = {
  completed: { label: "已完成", tone: "success", icon: CheckCircle2 },
  failed: { label: "失败", tone: "danger", icon: XCircle },
  cancelled: { label: "已取消", tone: "neutral", icon: Ban },
};

/** Motion fallback for users who asked the system (or the app) for less movement. */
const REDUCED_LIST: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.02 } },
};

const REDUCED_ITEM: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: duration.fast, ease: ease.standard } },
  exit: { opacity: 0, transition: { duration: duration.fast, ease: ease.standard } },
};

/** History timestamps arrive as `YYYY-MM-DD HH:MM:SS`; parse defensively. */
function timestamp(value: string): number {
  const parsed = Date.parse(value.replace(" ", "T"));
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Honour the OS preference and the in-app Motion setting.
 *
 * The setting wins when it is explicit, exactly like `prefersReducedMotion()` in the
 * settings store — but reactive, so switching it takes effect without a reload.
 */
function useMotionReduced(): boolean {
  const setting = useSettingsStore(
    (state) => state.settings?.appearance.motion ?? "system",
  );
  const system = useReducedMotion() ?? false;
  return setting === "reduced" || (setting === "system" && system);
}

/* -------------------------------------------------------------------------- */
/* Actions that outlive a single row                                          */
/* -------------------------------------------------------------------------- */

/** Re-queue a record with its original hints; the backend resolves the format again. */
async function redownload(entry: HistoryEntry): Promise<void> {
  try {
    const result = await enqueueDownloads([
      {
        url: entry.url,
        selection: null,
        titleHint: entry.title,
        thumbnailHint: entry.thumbnail,
        uploaderHint: entry.uploader,
        durationHint: entry.duration,
      },
    ]);
    if (result.ids.length === 0) {
      toast.warning("没有加入新的下载任务");
      return;
    }
    toast.success("已重新加入下载队列", entry.title);
    useUiStore.getState().setPage("queue");
  } catch (error) {
    toast.error(
      "加入下载队列失败",
      error instanceof IpcError ? error.message : String(error),
    );
  }
}

/** Deleting a downloaded file is destructive, so it always asks first. */
function confirmDeleteFile(entry: HistoryEntry): void {
  const path = entry.filePath;
  if (!path) {
    return;
  }
  useUiStore.getState().openConfirm({
    title: "删除已下载的文件？",
    description: `“${entry.title}”会从磁盘上永久删除，对应的历史记录也会一并移除，此操作无法撤销。`,
    confirmLabel: "删除文件",
    danger: true,
    onConfirm: () => useLibraryStore.getState().deleteFile(path, entry.id),
  });
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export function HistoryPage() {
  const history = useLibraryStore((state) => state.history);
  const loading = useLibraryStore((state) => state.loading);
  const filter = useLibraryStore((state) => state.historyFilter);
  const search = useLibraryStore((state) => state.search);
  const setFilter = useLibraryStore((state) => state.setHistoryFilter);
  const setSearch = useLibraryStore((state) => state.setSearch);
  const clearHistory = useLibraryStore((state) => state.clearHistory);
  const setPage = useUiStore((state) => state.setPage);
  const openConfirm = useUiStore((state) => state.openConfirm);
  const reduce = useMotionReduced();

  const counts = useMemo(
    () => ({
      completed: history.filter((entry) => entry.status === "completed").length,
      failed: history.filter((entry) => entry.status === "failed").length,
      cancelled: history.filter((entry) => entry.status === "cancelled").length,
    }),
    [history],
  );

  const downloadedBytes = useMemo(() => totalDownloaded(history), [history]);

  // The backend already answers newest first; sorting again keeps the page honest if
  // an optimistic store update ever reorders the list.
  const rows = useMemo(
    () =>
      [...selectVisibleHistory(history, filter, search)].sort(
        (left, right) => timestamp(right.finishedAt) - timestamp(left.finishedAt),
      ),
    [history, filter, search],
  );

  const segments = useMemo<Segment<HistoryFilter>[]>(
    () => [
      { value: "all", label: "全部", badge: String(history.length) },
      { value: "completed", label: "已完成", badge: String(counts.completed) },
      { value: "failed", label: "失败", badge: String(counts.failed) },
      { value: "cancelled", label: "已取消", badge: String(counts.cancelled) },
    ],
    [history.length, counts],
  );

  const unfinished = counts.failed + counts.cancelled;

  const resetFilters = useCallback(() => {
    setFilter("all");
    setSearch("");
  }, [setFilter, setSearch]);

  const clearFailed = useCallback(() => {
    openConfirm({
      title: "清理失败与已取消的记录？",
      description: `将移除 ${unfinished} 条未成功完成的记录。已下载的文件会保留。`,
      confirmLabel: "清理",
      danger: true,
      onConfirm: () => clearHistory(true),
    });
  }, [openConfirm, clearHistory, unfinished]);

  const clearAll = useCallback(() => {
    openConfirm({
      title: "清空全部下载历史？",
      description: `将移除全部 ${history.length} 条记录。已下载的文件会保留，但记录无法恢复。`,
      confirmLabel: "清空历史",
      danger: true,
      onConfirm: () => clearHistory(false),
    });
  }, [openConfirm, clearHistory, history.length]);

  const showToolbar = loading || history.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <SectionHeader
        title="下载历史"
        description={
          history.length > 0
            ? `共 ${formatCount(history.length)} 条记录，按完成时间从新到旧排列`
            : "完成的下载会自动记录在这里"
        }
        action={
          history.length > 0 ? (
            <div className="flex flex-wrap items-end justify-end gap-x-6 gap-y-2">
              <MetaItem label="已完成" value={formatCount(counts.completed)} />
              <MetaItem label="失败" value={formatCount(counts.failed)} />
              <MetaItem label="已取消" value={formatCount(counts.cancelled)} />
              <MetaItem label="累计下载" value={formatBytes(downloadedBytes)} />
            </div>
          ) : null
        }
      />

      {showToolbar ? (
        <div className="panel flex flex-wrap items-center gap-2.5 p-2.5">
          <SegmentedControl
            value={filter}
            segments={segments}
            onChange={setFilter}
            size="sm"
            layoutId="history-filter"
          />

          <div className="ml-auto flex min-w-0 items-center gap-2">
            <TextInput
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索标题、上传者或链接"
              aria-label="搜索下载历史"
              inputSize="sm"
              className="w-[13.5rem] shrink-0"
              icon={<Search className="size-3.5" />}
              trailing={
                search ? (
                  <IconButton label="清除搜索" size="xs" onClick={() => setSearch("")}>
                    <X className="size-3.5" />
                  </IconButton>
                ) : undefined
              }
            />

            <Menu
              align="end"
              trigger={
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Eraser className="size-3.5" />}
                  trailing={<ChevronDown className="size-3.5 text-content-tertiary" />}
                >
                  清理
                </Button>
              }
            >
              <MenuItem
                icon={<Eraser className="size-3.5" />}
                disabled={unfinished === 0}
                onSelect={clearFailed}
              >
                清理失败记录
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<Trash2 className="size-3.5" />}
                danger
                disabled={history.length === 0}
                onSelect={clearAll}
              >
                清空历史
              </MenuItem>
            </Menu>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
        {loading ? (
          <HistorySkeleton />
        ) : history.length === 0 ? (
          <div className="panel">
            <EmptyState
              icon={HistoryIcon}
              title="还没有下载记录"
              description="每一次下载结束后都会在这里留下记录，方便再次打开文件、定位目录或重新下载。"
              action={
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Download className="size-3.5" />}
                  onClick={() => setPage("home")}
                >
                  新建下载
                </Button>
              }
            />
          </div>
        ) : rows.length === 0 ? (
          <div className="panel">
            <EmptyState
              className="py-10"
              icon={SearchX}
              title="没有符合条件的记录"
              description="换一个关键词，或者清除当前的筛选条件。"
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<RotateCcw className="size-3.5" />}
                  onClick={resetFilters}
                >
                  清除筛选条件
                </Button>
              }
            />
          </div>
        ) : (
          <motion.ul
            variants={reduce ? REDUCED_LIST : listVariants}
            initial="initial"
            animate="animate"
            className="flex flex-col gap-2"
          >
            <AnimatePresence initial={false}>
              {rows.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} reduce={reduce} />
              ))}
            </AnimatePresence>
          </motion.ul>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Row                                                                        */
/* -------------------------------------------------------------------------- */

function HistoryRow({ entry, reduce }: { entry: HistoryEntry; reduce: boolean }) {
  const [imageFailed, setImageFailed] = useState(false);
  const openFile = useLibraryStore((state) => state.openFile);
  const revealFile = useLibraryStore((state) => state.revealFile);
  const copyLink = useLibraryStore((state) => state.copyLink);
  const removeHistory = useLibraryStore((state) => state.removeHistory);

  const status = STATUS_META[entry.status];
  const StatusIcon = status.icon;
  const filePath = entry.filePath;
  // Only a finished record owns a file, and only if the backend stored its path.
  const fileReady = entry.status === "completed" && filePath !== null;
  const fileHint = fileReady
    ? undefined
    : entry.status === "completed"
      ? "该记录没有保存文件路径"
      : "只有下载完成的文件才能操作";
  const container = entry.container ? containerLabel(entry.container) : null;

  return (
    <motion.li
      layout={!reduce}
      variants={reduce ? REDUCED_ITEM : itemVariants}
      className="panel row-hover flex items-start gap-3.5 p-3"
    >
      <div className="relative aspect-video w-[9.5rem] shrink-0 overflow-hidden rounded-[var(--radius-md)] border border-line-subtle bg-surface-sunken">
        {entry.thumbnail && !imageFailed ? (
          <img
            src={entry.thumbnail}
            alt=""
            loading="lazy"
            onError={() => setImageFailed(true)}
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-content-tertiary">
            <Film className="size-5" strokeWidth={1.6} />
          </div>
        )}
        {entry.duration ? (
          <span className="absolute right-1.5 bottom-1.5 rounded-[var(--radius-xs)] bg-background/80 px-1.5 py-px text-micro font-medium tabular-nums text-content">
            {formatDuration(entry.duration)}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-body font-medium text-content" title={entry.title}>
            {entry.title}
          </span>
          <Badge tone={status.tone} icon={<StatusIcon className="size-3" />}>
            {status.label}
          </Badge>
          {container && entry.status === "completed" ? (
            <Badge tone="neutral">{container}</Badge>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption text-content-tertiary">
          {entry.uploader ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <User2 className="size-3.5 shrink-0" />
              <span className="truncate">{entry.uploader}</span>
            </span>
          ) : null}
          {entry.selectionLabel ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Layers className="size-3.5 shrink-0" />
              <span className="truncate">{entry.selectionLabel}</span>
            </span>
          ) : null}
          {entry.sizeBytes > 0 ? (
            <span className="tabular-nums">{formatBytes(entry.sizeBytes)}</span>
          ) : null}
          <span className="inline-flex shrink-0 items-center gap-1.5 tabular-nums">
            <Clock3 className="size-3.5" />
            {formatRelative(entry.finishedAt)}
          </span>
        </div>

        {filePath ? <PathLine path={filePath} /> : null}

        {entry.error ? (
          <div className="flex items-start gap-1.5 text-caption leading-[1.05rem] text-content-tertiary">
            <AlertTriangle className="mt-px size-3.5 shrink-0 text-danger/70" />
            <p className="line-clamp-2 min-w-0" title={entry.error}>
              {entry.error}
            </p>
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
        <Action
          icon={<Play className="size-4" />}
          label="打开文件"
          hint={fileHint}
          disabled={!fileReady}
          onSelect={() => void openFile(filePath)}
        />
        <Action
          icon={<FolderOpen className="size-4" />}
          label="打开文件夹"
          hint={fileHint}
          disabled={!fileReady}
          onSelect={() => void revealFile(filePath)}
        />
        <Action
          icon={<RotateCcw className="size-4" />}
          label="重新下载"
          onSelect={() => void redownload(entry)}
        />
        <Menu
          align="end"
          trigger={
            <IconButton label="更多操作">
              <MoreHorizontal className="size-4" />
            </IconButton>
          }
        >
          <MenuItem
            icon={<Copy className="size-3.5" />}
            onSelect={() => void copyLink(entry.url)}
          >
            复制链接
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<Trash2 className="size-3.5" />}
            danger
            disabled={!fileReady}
            onSelect={() => confirmDeleteFile(entry)}
          >
            删除文件
          </MenuItem>
          <MenuItem
            icon={<FileX2 className="size-3.5" />}
            danger
            onSelect={() => void removeHistory(entry.id)}
          >
            删除记录
          </MenuItem>
        </Menu>
      </div>
    </motion.li>
  );
}

/** The stored path, trimmed for the row and spelled out in full on hover. */
function PathLine({ path }: { path: string }) {
  return (
    <Tooltip label={<span className="break-all">{path}</span>}>
      <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-caption text-content-tertiary">
        <FolderOpen className="size-3.5 shrink-0" />
        <span className="truncate font-mono text-micro">{shortenPath(path)}</span>
      </span>
    </Tooltip>
  );
}

/**
 * Row action.
 *
 * The tooltip wraps a span so the hint stays reachable while the button itself is
 * disabled — that is where the reason for the disabled state is written.
 */
function Action({
  icon,
  label,
  hint,
  disabled = false,
  danger = false,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}) {
  return (
    <Tooltip label={hint ?? label}>
      <span className="inline-flex">
        <IconButton
          label={label}
          variant={danger ? "danger" : "ghost"}
          disabled={disabled}
          onClick={onSelect}
        >
          {icon}
        </IconButton>
      </span>
    </Tooltip>
  );
}

/** Loading placeholder shaped like a history row, so the list does not jump. */
function HistorySkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="panel flex items-start gap-3.5 p-3">
          <Skeleton className="aspect-video w-[9.5rem] shrink-0" rounded="md" />
          <div className="flex min-w-0 flex-1 flex-col gap-2 py-0.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Skeleton className="size-8" rounded="sm" />
            <Skeleton className="size-8" rounded="sm" />
            <Skeleton className="size-8" rounded="sm" />
          </div>
        </div>
      ))}
    </div>
  );
}
