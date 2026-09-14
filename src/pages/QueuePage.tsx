/**
 * Queue — the download manager.
 *
 * The page is deliberately thin: the store owns the queue, `selectVisibleTasks` owns
 * filtering and each card owns its own actions. Rendering stays cheap because the only
 * thing that changes several times a second is the `tasks` array, while every card is
 * memoised on its own task object.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Download,
  Eraser,
  FunnelX,
  Hourglass,
  Inbox,
  ListChecks,
  Search,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";

import { TaskCard } from "@/components/download/TaskCard";
import { Button, IconButton } from "@/components/ui/Button";
import { SegmentedControl, TextInput, type Segment } from "@/components/ui/Controls";
import { EmptyState } from "@/components/ui/Feedback";
import { TaskCardSkeleton } from "@/components/ui/Progress";
import { SectionHeader } from "@/components/ui/Surface";
import { cn } from "@/lib/cn";
import { listVariants } from "@/lib/motion";
import { selectVisibleTasks, useTasksStore, type QueueFilter } from "@/stores/tasks";
import { useUiStore } from "@/stores/ui";
import type { DownloadTask } from "@/types/models";

/* -------------------------------------------------------------------------- */
/* Counters                                                                   */
/* -------------------------------------------------------------------------- */

interface TaskCounts {
  total: number;
  active: number;
  queued: number;
  completed: number;
  failed: number;
  paused: number;
}

/**
 * Same buckets as `useQueueCounts`, but derived from the task array this page already
 * subscribes to.
 *
 * `useQueueCounts` builds a fresh object inside its selector; with zustand v5 (which no
 * longer memoises selector output) React's post-commit snapshot check sees a new value
 * on every render and re-renders forever, so a page must not subscribe through it.
 */
function countTasks(tasks: DownloadTask[]): TaskCounts {
  const counts: TaskCounts = {
    total: tasks.length,
    active: 0,
    queued: 0,
    completed: 0,
    failed: 0,
    paused: 0,
  };

  for (const task of tasks) {
    if (task.state === "queued") {
      counts.queued += 1;
    } else if (task.state === "paused") {
      counts.paused += 1;
    } else if (task.state === "completed") {
      counts.completed += 1;
    } else if (task.state === "failed") {
      counts.failed += 1;
    } else if (
      task.state === "probing" ||
      task.state === "downloading" ||
      task.state === "merging"
    ) {
      counts.active += 1;
    }
  }

  return counts;
}

function countFor(counts: TaskCounts, filter: QueueFilter): number {
  switch (filter) {
    case "active":
      return counts.active;
    case "queued":
      return counts.queued;
    case "completed":
      return counts.completed;
    case "failed":
      return counts.failed;
    case "paused":
      return counts.paused;
    default:
      return counts.total;
  }
}

/* -------------------------------------------------------------------------- */
/* Lookup tables                                                              */
/* -------------------------------------------------------------------------- */

const FILTER_LABELS: Record<QueueFilter, string> = {
  all: "全部",
  active: "进行中",
  queued: "等待中",
  completed: "已完成",
  failed: "失败",
  paused: "已暂停",
};

const FILTER_ORDER: QueueFilter[] = [
  "all",
  "active",
  "queued",
  "completed",
  "failed",
  "paused",
];

const SUMMARY_CELLS: {
  key: keyof TaskCounts;
  label: string;
  icon: LucideIcon;
  /** Applied only while the bucket is non-empty, so an empty queue stays calm. */
  lit: string;
}[] = [
  {
    key: "total",
    label: "总任务",
    icon: ListChecks,
    lit: "bg-surface-active text-content-secondary",
  },
  { key: "active", label: "进行中", icon: Download, lit: "bg-accent-soft text-accent" },
  { key: "queued", label: "等待中", icon: Hourglass, lit: "bg-info-soft text-info" },
  { key: "failed", label: "失败", icon: TriangleAlert, lit: "bg-danger-soft text-danger" },
];

const SKELETON_ROWS = [0, 1, 2, 3];

/** A badge of "0" is noise; the segment label already says the bucket exists. */
function badgeText(count: number): string | undefined {
  return count > 0 ? String(count) : undefined;
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export function QueuePage() {
  const tasks = useTasksStore((state) => state.tasks);
  const loading = useTasksStore((state) => state.loading);
  const filter = useTasksStore((state) => state.filter);
  const search = useTasksStore((state) => state.search);
  const setFilter = useTasksStore((state) => state.setFilter);
  const setSearch = useTasksStore((state) => state.setSearch);
  const reduce = useReducedMotion();

  const counts = useMemo(() => countTasks(tasks), [tasks]);
  const visible = useMemo(
    () => selectVisibleTasks(tasks, filter, search),
    [tasks, filter, search],
  );

  const segments: Segment<QueueFilter>[] = FILTER_ORDER.map((value) => ({
    value,
    label: FILTER_LABELS[value],
    badge: badgeText(countFor(counts, value)),
  }));

  const description =
    tasks.length === 0
      ? loading
        ? "正在读取下载队列…"
        : "这里会实时显示每个任务的阶段、速度与剩余时间"
      : `共 ${counts.total} 个任务 · ${counts.active} 个进行中 · ${counts.completed} 个已完成`;

  const clearFilters = () => {
    setFilter("all");
    setSearch("");
  };

  const confirmClearFinished = () => {
    useUiStore.getState().openConfirm({
      title: "清理已完成的下载？",
      description: "已完成的任务记录会从队列中移除，已下载的文件会保留在磁盘上。",
      confirmLabel: "全部清理",
      danger: true,
      onConfirm: () => useTasksStore.getState().clearFinished(false),
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <SectionHeader
        title="下载队列"
        description={description}
        action={
          <Button
            variant="secondary"
            size="sm"
            icon={<Eraser className="size-3.5" />}
            onClick={confirmClearFinished}
            disabled={counts.completed === 0}
            title="移除队列中所有已完成的记录，不会删除已下载的文件"
          >
            全部清理已完成
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          value={filter}
          segments={segments}
          onChange={setFilter}
          layoutId="queue-filter"
          className="min-w-0 shrink-0"
        />
        <TextInput
          className="ml-auto w-full min-w-[12rem] max-w-[18rem] flex-1"
          icon={<Search className="size-3.5" />}
          placeholder="搜索标题、链接或作者"
          aria-label="搜索下载任务"
          spellCheck={false}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          trailing={
            search.length > 0 ? (
              <IconButton label="清除搜索" size="xs" onClick={() => setSearch("")}>
                <X className="size-3.5" />
              </IconButton>
            ) : undefined
          }
        />
      </div>

      <SummaryStrip counts={counts} />

      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {loading ? (
          <div className="flex flex-col gap-2.5">
            {SKELETON_ROWS.map((row) => (
              <TaskCardSkeleton key={row} />
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex min-h-full items-center justify-center">
            <EmptyState
              className="max-w-lg"
              icon={Inbox}
              title="还没有下载任务"
              description="在“新建下载”里粘贴一个视频链接，任务会立即出现在这里，并实时显示下载进度。"
              action={
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Download className="size-3.5" />}
                  onClick={() => useUiStore.getState().setPage("home")}
                >
                  新建下载
                </Button>
              }
            />
          </div>
        ) : visible.length === 0 ? (
          <div className="flex min-h-full items-center justify-center">
            <FilteredEmpty
              filter={filter}
              search={search}
              onClear={clearFilters}
            />
          </div>
        ) : (
          <motion.div
            variants={reduce ? undefined : listVariants}
            initial={reduce ? false : "initial"}
            animate={reduce ? undefined : "animate"}
            className="flex flex-col gap-2.5"
          >
            {/* No `initial={false}`: cards should stagger in on first paint too. */}
            <AnimatePresence>
              {visible.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

/** total / active / queued / failed, in one calm strip instead of four cards. */
function SummaryStrip({ counts }: { counts: TaskCounts }) {
  return (
    <div className="panel grid grid-cols-4 divide-x divide-line-subtle overflow-hidden">
      {SUMMARY_CELLS.map((cell) => {
        const Icon = cell.icon;
        const value = counts[cell.key];
        const empty = value === 0;

        return (
          <div key={cell.key} className="flex min-w-0 items-center gap-2.5 px-3.5 py-2">
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)]",
                empty ? "bg-surface-hover text-content-tertiary" : cell.lit,
              )}
            >
              <Icon className="size-4" strokeWidth={1.9} />
            </span>
            <div className="min-w-0">
              <p
                className={cn(
                  "text-heading leading-[1.25rem] font-semibold tabular-nums",
                  empty ? "text-content-tertiary" : "text-content",
                )}
              >
                {value}
              </p>
              <p className="truncate text-micro text-content-tertiary">{cell.label}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The lighter state for "the queue has tasks, this view has none". */
function FilteredEmpty({
  filter,
  search,
  onClear,
}: {
  filter: QueueFilter;
  search: string;
  onClear: () => void;
}) {
  const needle = search.trim();

  return (
    <div className="panel flex w-full max-w-lg flex-col items-center gap-3 px-6 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-[var(--radius-lg)] border border-line bg-surface-elevated text-content-tertiary">
        <FunnelX className="size-4" strokeWidth={1.7} />
      </span>
      <div className="space-y-1">
        <h3 className="text-label font-semibold text-content">没有符合条件的任务</h3>
        <p className="text-caption leading-[1.1rem] text-content-tertiary">
          {needle.length > 0
            ? `没有标题、链接或作者包含“${needle}”的任务。`
            : `“${FILTER_LABELS[filter]}”筛选下暂时没有任务。`}
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        icon={<X className="size-3.5" />}
        onClick={onClear}
      >
        清除筛选条件
      </Button>
    </div>
  );
}
