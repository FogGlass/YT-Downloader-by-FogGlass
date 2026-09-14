/** Settings, runtime health and logging. */

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { IpcError } from "@/api/client";
import * as settingsApi from "@/api/settings";
import * as runtimeApi from "@/api/runtime";
import { toast } from "@/stores/toasts";
import type {
  AppInfo,
  AppSettings,
  LogEntry,
  RuntimeStatus,
  SettingsPatch,
  StorageInfo,
  ThemeMode,
} from "@/types/models";

interface SettingsState {
  settings: AppSettings | null;
  runtime: RuntimeStatus | null;
  storage: StorageInfo | null;
  info: AppInfo | null;
  logs: LogEntry[];
  loading: boolean;
  saving: boolean;
  error: string | null;

  load: () => Promise<void>;
  patch: (patch: SettingsPatch, options?: { quiet?: boolean }) => Promise<void>;
  reset: () => Promise<void>;
  refreshRuntime: () => Promise<void>;
  setRuntime: (status: RuntimeStatus) => void;
  loadLogs: () => Promise<void>;
  clearLogs: () => Promise<void>;
  appendLog: (entry: LogEntry) => void;
  refreshStorage: () => Promise<void>;
}

/** Vertical slice of the settings the shell needs immediately. */
export interface AppearanceSnapshot {
  theme: ThemeMode;
  accent: string;
  compact: boolean;
  motion: "system" | "full" | "reduced";
  ambient: boolean;
  sidebarLabels: boolean;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  runtime: null,
  storage: null,
  info: null,
  logs: [],
  loading: true,
  saving: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [settings, runtime, storage, info] = await Promise.all([
        settingsApi.getSettings(),
        runtimeApi.runtimeStatus().catch(() => null),
        settingsApi.storageInfo().catch(() => null),
        runtimeApi.appInfo().catch(() => null),
      ]);
      set({ settings, runtime, storage, info, loading: false });
      applyAppearance(settings);
    } catch (error) {
      const message = error instanceof IpcError ? error.message : String(error);
      set({ loading: false, error: message });
      toast.error("无法加载设置", message);
    }
  },

  patch: async (patch, options) => {
    set({ saving: true });
    try {
      const settings = await settingsApi.updateSettings(patch);
      set({ settings, saving: false });
      applyAppearance(settings);
      // Appearance changes that live on the native window need an explicit push.
      if (patch.appearance?.nativeDecorations !== undefined) {
        await runtimeApi
          .applyWindowAppearance(settings.appearance.nativeDecorations)
          .catch(() => undefined);
      }
      if (!options?.quiet) {
        toast.success("设置已保存");
      }
    } catch (error) {
      const message = error instanceof IpcError ? error.message : String(error);
      set({ saving: false });
      toast.error("保存设置失败", message);
    }
  },

  reset: async () => {
    set({ saving: true });
    try {
      const settings = await settingsApi.resetSettings();
      set({ settings, saving: false });
      applyAppearance(settings);
      toast.success("已恢复默认设置");
    } catch (error) {
      const message = error instanceof IpcError ? error.message : String(error);
      set({ saving: false });
      toast.error("恢复默认设置失败", message);
    }
  },

  refreshRuntime: async () => {
    try {
      const runtime = await runtimeApi.runtimeStatus();
      set({ runtime });
    } catch (error) {
      const message = error instanceof IpcError ? error.message : String(error);
      toast.error("运行库检测失败", message);
    }
  },

  setRuntime: (runtime) => set({ runtime }),

  loadLogs: async () => {
    try {
      const logs = await settingsApi.recentLogs(400);
      set({ logs });
    } catch {
      // Logging is diagnostic only: a failure here must stay silent.
    }
  },

  clearLogs: async () => {
    await settingsApi.clearLogs();
    set({ logs: [] });
  },

  appendLog: (entry) =>
    set((state) => ({ logs: [...state.logs, entry].slice(-500) })),

  refreshStorage: async () => {
    try {
      const storage = await settingsApi.storageInfo();
      set({ storage });
    } catch {
      // Non-critical.
    }
  },
}));

/**
 * Push the appearance settings onto the document root.
 *
 * The theme is resolved here (including `system`) so both the CSS tokens and the
 * `color-scheme` used by native form controls stay in sync.
 */
export function applyAppearance(settings: AppSettings): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const appearance = settings.appearance;

  const prefersLight =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: light)").matches;

  const resolved =
    appearance.theme === "system" ? (prefersLight ? "light" : "dark") : appearance.theme;

  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;

  root.dataset.accent = appearance.accent || "violet";
  root.dataset.density = appearance.compact ? "compact" : "comfortable";
  root.dataset.motion = appearance.motion === "full" ? "full" : appearance.motion === "reduced" ? "reduced" : "system";
}

/** React to an OS theme change while the app is running. */
export function watchSystemTheme(): () => void {
  if (typeof window === "undefined" || !window.matchMedia) {
    return () => undefined;
  }
  const query = window.matchMedia("(prefers-color-scheme: light)");
  const handler = () => {
    const settings = useSettingsStore.getState().settings;
    if (settings && settings.appearance.theme === "system") {
      applyAppearance(settings);
    }
  };
  query.addEventListener("change", handler);
  return () => query.removeEventListener("change", handler);
}

/** True when non-essential animation should be suppressed. */
export function prefersReducedMotion(): boolean {
  const settings = useSettingsStore.getState().settings?.appearance.motion ?? "system";
  if (settings === "reduced") {
    return true;
  }
  if (settings === "full") {
    return false;
  }
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Read a nested slice without re-rendering on unrelated settings changes.
 *
 * `useShallow` keeps the returned object referentially stable across renders —
 * without it React's `useSyncExternalStore` snapshot check would loop forever.
 */
export function useAppearance(): AppearanceSnapshot {
  return useSettingsStore(
    useShallow((state) => ({
      theme: state.settings?.appearance.theme ?? "dark",
      accent: state.settings?.appearance.accent ?? "violet",
      compact: state.settings?.appearance.compact ?? false,
      motion: state.settings?.appearance.motion ?? "system",
      ambient: state.settings?.appearance.ambientBackground ?? true,
      sidebarLabels: state.settings?.appearance.showSidebarLabels ?? true,
    })),
  );
}

/** Expert mode unlocks raw commands and verbose logs in the UI. */
export const useExpertMode = () =>
  useSettingsStore((state) => state.settings?.advanced.expertMode ?? false);
