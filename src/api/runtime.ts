/** Runtime discovery, shell integration and window control. */

import { call } from "./client";
import type { AppInfo, PathFacts, RuntimeStatus } from "@/types/models";

export const runtimeStatus = () => call<RuntimeStatus>("runtime_status");

export const openPath = (path: string) => call<void>("open_path", { path });

/** Open an http(s) link in the default browser (the target need not exist on disk). */
export const openUrl = (url: string) => call<void>("open_url", { url });

export const revealPath = (path: string) => call<void>("reveal_path", { path });

export const openFolder = (path: string) => call<void>("open_folder", { path });

export const pathFacts = (path: string) => call<PathFacts>("path_facts", { path });

export const deleteFile = (path: string) => call<void>("delete_file", { path });

export const applyWindowAppearance = (
  nativeDecorations: boolean,
  title?: string,
) =>
  call<void>("apply_window_appearance", {
    nativeDecorations,
    title: title ?? null,
  });

export const focusWindow = () => call<void>("focus_window");

export const appInfo = () => call<AppInfo>("app_info");

export const confirmExit = () => call<void>("confirm_exit");
