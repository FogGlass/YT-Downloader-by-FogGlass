/** Toast notifications: a tiny store plus the matching host component. */

import { create } from "zustand";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  description?: string;
  action?: ToastAction;
  /** Milliseconds before auto-dismissal; 0 keeps it until dismissed. */
  duration: number;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id" | "duration"> & { duration?: number }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const DEFAULT_DURATION = 4200;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((state) => ({
      // Newest first so the stack reads top-down.
      toasts: [
        {
          id,
          duration: toast.duration ?? DEFAULT_DURATION,
          kind: toast.kind,
          title: toast.title,
          description: toast.description,
          action: toast.action,
        },
        ...state.toasts,
      ].slice(0, 4),
    }));
    return id;
  },
  dismiss: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** Convenience wrappers so call sites stay short. */
export const toast = {
  /** Full control, used when a notification needs an action button and no timeout. */
  push: (toast: Omit<Toast, "id" | "duration"> & { duration?: number }) =>
    useToastStore.getState().push(toast),
  info: (title: string, description?: string) =>
    useToastStore.getState().push({ kind: "info", title, description }),
  success: (title: string, description?: string) =>
    useToastStore.getState().push({ kind: "success", title, description }),
  warning: (title: string, description?: string) =>
    useToastStore.getState().push({ kind: "warning", title, description }),
  error: (title: string, description?: string, action?: ToastAction) =>
    useToastStore.getState().push({
      kind: "error",
      title,
      description,
      action,
      duration: action ? 8000 : DEFAULT_DURATION,
    }),
};
