/**
 * Bridges backend events into the stores.
 *
 * Subscribed once by the shell. Progress events only patch the progress object so a
 * running download never forces a full list re-render.
 */

import { useEffect } from "react";

import { events, isDesktop, subscribe } from "@/api/client";
import * as runtimeApi from "@/api/runtime";
import { toast } from "@/stores/toasts";
import { useLibraryStore } from "@/stores/library";
import { useSettingsStore } from "@/stores/settings";
import { useTasksStore } from "@/stores/tasks";
import type {
  DownloadProgress,
  DownloadResult,
  LogEntry,
  RuntimeStatus,
  TaskError,
  DownloadTask,
} from "@/types/models";

interface ProgressEvent {
  id: string;
  progress: DownloadProgress;
}

export function useEventBridge(): void {
  useEffect(() => {
    if (!isDesktop()) {
      return;
    }

    const disposers: Array<() => void> = [];
    let cancelled = false;

    const track = async (event: string, handler: (payload: never) => void) => {
      const dispose = await subscribe(event, handler as (payload: unknown) => void);
      if (cancelled) {
        dispose();
      } else {
        disposers.push(dispose);
      }
    };

    void (async () => {
      await track(events.taskUpdate, (task: DownloadTask) => {
        useTasksStore.getState().upsert(task);
      });

      await track(events.taskProgress, (payload: ProgressEvent) => {
        useTasksStore.getState().applyProgress(payload.id, payload.progress);
      });

      await track(events.taskCompleted, (result: DownloadResult) => {
        const notify = useSettingsStore.getState().settings?.general.notifyOnComplete ?? true;
        // Refresh the library so History shows the new entry immediately.
        void useLibraryStore.getState().load();
        if (notify) {
          toast.push({
            kind: "success",
            title: "下载完成",
            description: result.fileName,
            duration: 6000,
            action: {
              label: "打开文件",
              run: () => {
                void runtimeApi.openPath(result.filePath).catch(() => undefined);
              },
            },
          });
        }
      });

      await track(events.taskFailed, (error: TaskError) => {
        toast.error("下载失败", error.summary);
        void useLibraryStore.getState().load();
      });

      await track(events.taskRemoved, (id: string) => {
        useTasksStore.getState().removeLocal(id);
      });

      await track(events.taskCleared, () => {
        void useTasksStore.getState().load();
      });

      await track(events.runtimeStatus, (status: RuntimeStatus) => {
        useSettingsStore.getState().setRuntime(status);
      });

      await track(events.log, (entry: LogEntry) => {
        useSettingsStore.getState().appendLog(entry);
      });

      await track(events.confirmExit, () => {
        // The window asked to close while downloads were running.
        const active = useTasksStore
          .getState()
          .tasks.filter((task) =>
            ["downloading", "merging", "probing"].includes(task.state),
          ).length;

        toast.push({
          kind: "warning",
          title: "仍有下载正在进行",
          description: `还有 ${active} 个任务未完成，确定要退出吗？`,
          duration: 0,
          action: {
            label: "仍然退出",
            run: () => {
              void runtimeApi.confirmExit().catch(() => undefined);
            },
          },
        });
      });
    })();

    return () => {
      cancelled = true;
      for (const dispose of disposers) {
        dispose();
      }
    };
  }, []);
}
