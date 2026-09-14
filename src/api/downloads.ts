/** Download queue control. Every function maps to a real backend action. */

import { call } from "./client";
import type {
  DownloadRequest,
  DownloadTask,
  EnqueueResult,
  QueueSummary,
} from "@/types/models";

export const enqueueDownloads = (requests: DownloadRequest[]) =>
  call<EnqueueResult>("enqueue_downloads", { requests });

export const listTasks = () => call<DownloadTask[]>("list_tasks");

export const getTask = (id: string) => call<DownloadTask | null>("get_task", { id });

/** Stop a task, keeping the partial data so it can be resumed. */
export const pauseTask = (id: string) => call<void>("pause_task", { id });

export const resumeTask = (id: string) => call<void>("resume_task", { id });

/** Stop a task and delete the partial files it created. */
export const cancelTask = (id: string) => call<void>("cancel_task", { id });

/** Re-run a task. `fromScratch` discards the partial files first. */
export const retryTask = (id: string, fromScratch = false) =>
  call<void>("retry_task", { id, fromScratch });

/** Recover a task whose streams finished but whose mux step failed. */
export const retryMerge = (id: string) => call<void>("retry_merge", { id });

export const removeTask = (id: string, deleteFiles = false) =>
  call<void>("remove_task", { id, deleteFiles });

export const clearFinishedTasks = (includeFailed = false) =>
  call<number>("clear_finished_tasks", { includeFailed });

export const queueSummary = () => call<QueueSummary>("queue_summary");
