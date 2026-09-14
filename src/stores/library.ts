/** History and favourites. */

import { create } from "zustand";

import { IpcError } from "@/api/client";
import * as libraryApi from "@/api/library";
import * as runtimeApi from "@/api/runtime";
import { useToastStore, toast } from "@/stores/toasts";
import type { FavoriteEntry, HistoryEntry, HistoryStatus } from "@/types/models";

export type HistoryFilter = "all" | HistoryStatus;

interface LibraryState {
  history: HistoryEntry[];
  favorites: FavoriteEntry[];
  loading: boolean;
  historyFilter: HistoryFilter;
  search: string;

  load: () => Promise<void>;
  setHistoryFilter: (filter: HistoryFilter) => void;
  setSearch: (search: string) => void;

  removeHistory: (id: string) => Promise<void>;
  clearHistory: (onlyFailed?: boolean) => Promise<void>;
  star: (entry: Omit<FavoriteEntry, "id" | "createdAt">) => Promise<void>;
  unstar: (id: string) => Promise<void>;
  isStarred: (url: string) => boolean;

  openFile: (path: string | null) => Promise<void>;
  revealFile: (path: string | null) => Promise<void>;
  deleteFile: (path: string | null, historyId: string) => Promise<void>;
  copyLink: (url: string) => Promise<void>;
}

function message(error: unknown): string {
  return error instanceof IpcError ? error.message : String(error);
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  history: [],
  favorites: [],
  loading: true,
  historyFilter: "all",
  search: "",

  load: async () => {
    try {
      const [history, favorites] = await Promise.all([
        libraryApi.historyList(1000),
        libraryApi.favoritesList(),
      ]);
      set({ history, favorites, loading: false });
    } catch (error) {
      set({ loading: false });
      toast.error("无法读取资料库", message(error));
    }
  },

  setHistoryFilter: (historyFilter) => set({ historyFilter }),
  setSearch: (search) => set({ search }),

  removeHistory: async (id) => {
    try {
      await libraryApi.historyRemove(id);
      set((state) => ({ history: state.history.filter((entry) => entry.id !== id) }));
    } catch (error) {
      toast.error("删除记录失败", message(error));
    }
  },

  clearHistory: async (onlyFailed = false) => {
    try {
      const removed = await libraryApi.historyClear(onlyFailed);
      await get().load();
      toast.info(removed > 0 ? `已清理 ${removed} 条记录` : "没有可清理的记录");
    } catch (error) {
      toast.error("清理历史失败", message(error));
    }
  },

  star: async (entry) => {
    try {
      const favorites = await libraryApi.favoritesUpsert({
        ...entry,
        id: "",
        createdAt: new Date().toISOString().slice(0, 19).replace("T", " "),
      } as FavoriteEntry);
      set({ favorites });
      toast.success("已加入收藏");
    } catch (error) {
      toast.error("收藏失败", message(error));
    }
  },

  unstar: async (id) => {
    try {
      const favorites = await libraryApi.favoritesRemove(id);
      set({ favorites });
      toast.info("已取消收藏");
    } catch (error) {
      toast.error("取消收藏失败", message(error));
    }
  },

  isStarred: (url) => get().favorites.some((entry) => entry.url === url),

  openFile: async (path) => {
    if (!path) {
      toast.warning("该记录没有可打开的文件");
      return;
    }
    try {
      await runtimeApi.openPath(path);
    } catch (error) {
      toast.error("无法打开文件", message(error));
    }
  },

  revealFile: async (path) => {
    if (!path) {
      toast.warning("该记录没有可定位的文件");
      return;
    }
    try {
      await runtimeApi.revealPath(path);
    } catch (error) {
      toast.error("无法定位文件", message(error));
    }
  },

  deleteFile: async (path, historyId) => {
    if (!path) {
      return;
    }
    try {
      await runtimeApi.deleteFile(path);
      await get().removeHistory(historyId);
      toast.success("文件已删除");
    } catch (error) {
      toast.error("删除文件失败", message(error));
    }
  },

  copyLink: async (url) => {
    try {
      await navigator.clipboard.writeText(url);
      useToastStore.getState().push({ kind: "info", title: "链接已复制" });
    } catch {
      toast.error("复制失败", "系统剪贴板不可用");
    }
  },
}));

/** Filter and search the history list. */
export function selectVisibleHistory(
  history: HistoryEntry[],
  filter: HistoryFilter,
  search: string,
): HistoryEntry[] {
  const needle = search.trim().toLowerCase();
  return history.filter((entry) => {
    if (filter !== "all" && entry.status !== filter) {
      return false;
    }
    if (!needle) {
      return true;
    }
    return (
      entry.title.toLowerCase().includes(needle) ||
      entry.url.toLowerCase().includes(needle) ||
      (entry.uploader ?? "").toLowerCase().includes(needle)
    );
  });
}

/** Total bytes across successful downloads, for the history header. */
export function totalDownloaded(history: HistoryEntry[]): number {
  return history.reduce(
    (sum, entry) => (entry.status === "completed" ? sum + entry.sizeBytes : sum),
    0,
  );
}
