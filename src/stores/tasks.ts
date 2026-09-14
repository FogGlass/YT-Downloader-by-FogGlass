/** The download queue as the backend reports it. */

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { IpcError } from "@/api/client";
import * as downloadsApi from "@/api/downloads";
import * as runtimeApi from "@/api/runtime";
import { toast } from "@/stores/toasts";
import type {
  DownloadProgress,
  DownloadRequest,
  DownloadTask,
  TaskState,
} from "@/types/models";

export type QueueFilter =
  | "all"
  | "active"
  | "queued"
  | "completed"
  | "failed"
  | "paused";

interface TasksState {
  tasks: DownloadTask[];
  loading: boolean;
  filter: QueueFilter;
  search: string;
  /** Task ids that were just updated, used for one-shot highlight animations. */
  highlighted: string | null;

  load: () => Promise<void>;
  enqueue: (requests: DownloadRequest[]) => Promise<string[]>;
  upsert: (task: DownloadTask) => void;
  applyProgress: (id: string, progress: DownloadProgress) => void;
  removeLocal: (id: string) => void;
  setFilter: (filter: QueueFilter) => void;
  setSearch: (search: string) => void;
  highlight: (id: string | null) => void;

  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  retry: (id: string, fromScratch?: boolean) => Promise<void>;
  retryMerge: (id: string) => Promise<void>;
  remove: (id: string, deleteFiles?: boolean) => Promise<void>;
  clearFinished: (includeFailed?: boolean) => Promise<void>;
  openOutput: (id: string) => Promise<void>;
  revealOutput: (id: string) => Promise<void>;
}

const STATE_ORDER: Record<TaskState, number> = {
  downloading: 0,
  merging: 1,
  probing: 2,
  queued: 3,
  paused: 4,
  failed: 5,
  cancelled: 6,
  completed: 7,
};

function sortTasks(tasks: DownloadTask[]): DownloadTask[] {
  return [...tasks].sort((left, right) => {
    const byState = STATE_ORDER[left.state] - STATE_ORDER[right.state];
    if (byState !== 0) {
      return byState;
    }
    return right.createdAt.localeCompare(left.createdAt);
  });
}

function message(error: unknown): string {
  return error instanceof IpcError ? error.message : String(error);
}

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: [],
  loading: true,
  filter: "all",
  search: "",
  highlighted: null,

  load: async () => {
    try {
      const tasks = await downloadsApi.listTasks();
      set({ tasks: sortTasks(tasks), loading: false });
    } catch (error) {
      set({ loading: false });
      toast.error("无法读取下载队列", message(error));
    }
  },

  enqueue: async (requests) => {
    try {
      const result = await downloadsApi.enqueueDownloads(requests);
      if (result.queued > 0) {
        toast.success(
          result.queued === 1 ? "已加入下载队列" : `已加入 ${result.queued} 个下载任务`,
        );
      }
      return result.ids;
    } catch (error) {
      toast.error("加入队列失败", message(error));
      return [];
    }
  },

  upsert: (task) =>
    set((state) => {
      const index = state.tasks.findIndex((existing) => existing.id === task.id);
      if (index === -1) {
        return { tasks: sortTasks([...state.tasks, task]) };
      }
      const tasks = [...state.tasks];
      tasks[index] = task;
      return { tasks: sortTasks(tasks) };
    }),

  applyProgress: (id, progress) =>
    set((state) => {
      const index = state.tasks.findIndex((task) => task.id === id);
      if (index === -1) {
        return state;
      }
      const tasks = [...state.tasks];
      // Only merge the fields the light event carries; everything else keeps the
      // values from the last full snapshot.
      tasks[index] = { ...tasks[index], progress: { ...tasks[index].progress, ...progress } };
      return { tasks };
    }),

  removeLocal: (id) =>
    set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) })),

  setFilter: (filter) => set({ filter }),
  setSearch: (search) => set({ search }),
  highlight: (id) => set({ highlighted: id }),

  pause: async (id) => {
    try {
      await downloadsApi.pauseTask(id);
    } catch (error) {
      toast.error("暂停失败", message(error));
    }
  },

  resume: async (id) => {
    try {
      await downloadsApi.resumeTask(id);
    } catch (error) {
      toast.error("继续失败", message(error));
    }
  },

  cancel: async (id) => {
    try {
      await downloadsApi.cancelTask(id);
      toast.info("已取消任务");
    } catch (error) {
      toast.error("取消失败", message(error));
    }
  },

  retry: async (id, fromScratch = false) => {
    try {
      await downloadsApi.retryTask(id, fromScratch);
      toast.info(fromScratch ? "已重新开始下载" : "已重试下载");
    } catch (error) {
      toast.error("重试失败", message(error));
    }
  },

  retryMerge: async (id) => {
    try {
      await downloadsApi.retryMerge(id);
      toast.info("正在重新合并", "不会重新下载已完成的流");
    } catch (error) {
      toast.error("重新合并失败", message(error));
    }
  },

  remove: async (id, deleteFiles = false) => {
    try {
      await downloadsApi.removeTask(id, deleteFiles);
      get().removeLocal(id);
    } catch (error) {
      toast.error("移除任务失败", message(error));
    }
  },

  clearFinished: async (includeFailed = false) => {
    try {
      const removed = await downloadsApi.clearFinishedTasks(includeFailed);
      await get().load();
      toast.info(removed > 0 ? `已清理 ${removed} 个任务` : "没有可清理的任务");
    } catch (error) {
      toast.error("清理失败", message(error));
    }
  },

  openOutput: async (id) => {
    const task = get().tasks.find((item) => item.id === id);
    const path = task?.output?.filePath;
    if (!path) {
      return;
    }
    try {
      await runtimeApi.openPath(path);
    } catch (error) {
      toast.error("无法打开文件", message(error));
    }
  },

  revealOutput: async (id) => {
    const task = get().tasks.find((item) => item.id === id);
    const path = task?.output?.filePath ?? task?.output?.directory;
    if (!path) {
      return;
    }
    try {
      await runtimeApi.revealPath(path);
    } catch (error) {
      toast.error("无法定位文件", message(error));
    }
  },
}));

/**
 * Counters for the sidebar badge, derived from the queue itself.
 *
 * `useShallow` is required: zustand v5 hands the selector straight to React's
 * `useSyncExternalStore`, which compares snapshots by identity. A selector that builds
 * a fresh object on every call would therefore never compare equal and would re-render
 * forever.
 */
export function useQueueCounts(): { active: number; queued: number; failed: number } {
  return useTasksStore(
    useShallow((state) => {
      let active = 0;
      let queued = 0;
      let failed = 0;
      for (const task of state.tasks) {
        if (task.state === "downloading" || task.state === "merging" || task.state === "probing") {
          active += 1;
        } else if (task.state === "queued") {
          queued += 1;
        } else if (task.state === "failed") {
          failed += 1;
        }
      }
      return { active, queued, failed };
    }),
  );
}

/** Apply the active filter and search box to the queue. */
export function selectVisibleTasks(
  tasks: DownloadTask[],
  filter: QueueFilter,
  search: string,
): DownloadTask[] {
  const needle = search.trim().toLowerCase();
  return tasks.filter((task) => {
    const matchesFilter =
      filter === "all"
        ? true
        : filter === "active"
          ? task.state === "downloading" || task.state === "merging" || task.state === "probing"
          : task.state === filter;
    if (!matchesFilter) {
      return false;
    }
    if (!needle) {
      return true;
    }
    return (
      task.title.toLowerCase().includes(needle) ||
      task.url.toLowerCase().includes(needle) ||
      (task.uploader ?? "").toLowerCase().includes(needle)
    );
  });
}
