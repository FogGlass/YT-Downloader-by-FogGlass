/**
 * The single gateway to the Rust backend.
 *
 * Components never call `invoke` directly — they call a typed function in `src/api`,
 * which calls this module. That keeps the IPC surface auditable in one place and
 * lets a development build run in a browser with a mock backend attached.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

import type { BackendError } from "@/types/models";

/** True when the page is running inside the Tauri shell. */
export const isDesktop = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export class IpcError extends Error {
  readonly kind: string;
  readonly detail: string | null;
  /** Actionable guidance from the backend, when the failure was classified. */
  readonly hint: string | null;

  constructor(error: BackendError) {
    super(error.message);
    this.name = "IpcError";
    this.kind = error.kind ?? "unknown";
    this.detail = error.detail ?? null;
    this.hint = error.hint ?? null;
  }
}

function normalise(error: unknown): IpcError {
  if (error instanceof IpcError) {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    const candidate = error as BackendError;
    return new IpcError({
      kind: candidate.kind ?? "unknown",
      message: String(candidate.message),
      detail: candidate.detail ?? null,
      hint: candidate.hint ?? null,
    });
  }
  if (typeof error === "string") {
    return new IpcError({ kind: "unknown", message: error });
  }
  return new IpcError({
    kind: "unknown",
    message: "发生未知错误",
    detail: String(error),
  });
}

/** Invoke a backend command, always failing with an {@link IpcError}. */
export async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    if (!isDesktop()) {
      // Browser preview: the packaged application always has the Rust backend, this
      // path exists so the interface can be reviewed and asserted on without a window.
      const { mockInvoke } = await import("./mock");
      return await mockInvoke<T>(command, args);
    }
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    throw normalise(error);
  }
}

/** Subscribe to a backend event; resolves to an unsubscribe function. */
export async function subscribe<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return tauriListen<T>(event, (message) => handler(message.payload));
}

/** Event names published by the backend. */
export const events = {
  taskUpdate: "task:update",
  taskProgress: "task:progress",
  taskCompleted: "task:completed",
  taskFailed: "task:failed",
  taskRemoved: "task:removed",
  taskCleared: "task:cleared",
  runtimeStatus: "runtime:status",
  log: "app:log",
  confirmExit: "app:confirm-exit",
} as const;
