/** Shell state: navigation, dialogs and the composer's transient UI. */

import { create } from "zustand";

export type PageId =
  | "home"
  | "queue"
  | "history"
  | "favorites"
  | "settings"
  | "about";

export const PAGES: { id: PageId; label: string; description: string }[] = [
  { id: "home", label: "新建下载", description: "解析链接并选择格式" },
  { id: "queue", label: "下载队列", description: "查看正在进行的任务" },
  { id: "history", label: "下载历史", description: "已完成与失败的记录" },
  { id: "favorites", label: "收藏", description: "保存的链接" },
  { id: "settings", label: "设置", description: "下载、网络与外观" },
  { id: "about", label: "关于", description: "版本与运行库信息" },
];

export interface ConfirmRequest {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

interface UiState {
  page: PageId;
  sidebarCollapsed: boolean;
  confirm: ConfirmRequest | null;
  /** URL handed over from another page (Favorites → Home, History → Home). */
  pendingUrl: string | null;

  setPage: (page: PageId) => void;
  toggleSidebar: () => void;
  openConfirm: (request: ConfirmRequest) => void;
  closeConfirm: () => void;
  sendToComposer: (url: string) => void;
  consumePendingUrl: () => string | null;
}

export const useUiStore = create<UiState>((set, get) => ({
  page: "home",
  sidebarCollapsed: false,
  confirm: null,
  pendingUrl: null,

  setPage: (page) => set({ page }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  openConfirm: (confirm) => set({ confirm }),
  closeConfirm: () => set({ confirm: null }),
  sendToComposer: (url) => set({ page: "home", pendingUrl: url }),
  consumePendingUrl: () => {
    const url = get().pendingUrl;
    if (url) {
      set({ pendingUrl: null });
    }
    return url;
  },
}));
