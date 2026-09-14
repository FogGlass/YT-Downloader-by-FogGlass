/** Settings, logging and storage information. */

import { call } from "./client";
import type {
  AppSettings,
  LogEntry,
  SettingsPatch,
  StorageInfo,
} from "@/types/models";

export const getSettings = () => call<AppSettings>("get_settings");

export const updateSettings = (patch: SettingsPatch) =>
  call<AppSettings>("update_settings", { patch });

export const resetSettings = () => call<AppSettings>("reset_settings");

export const recentLogs = (limit = 300) =>
  call<LogEntry[]>("recent_logs", { limit });

export const clearLogs = () => call<void>("clear_logs");

export const storageInfo = () => call<StorageInfo>("storage_info");
