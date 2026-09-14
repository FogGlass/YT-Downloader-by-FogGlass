/**
 * The installer window's typed IPC surface.
 *
 * Every setup command and event is wrapped exactly once here, so pages never touch
 * `invoke` or `listen` directly and every failure reaches the interface in the same
 * shape — a message plus optional technical detail — matching the main application's
 * `IpcError` vocabulary.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { IpcError } from "@/api/client";
import type {
  DirCheck,
  InstallOptions,
  SetupContext,
  SetupFinished,
  SetupProgress,
  UninstallOptions,
} from "./types";

export { IpcError };

/** Event names published by the setup backend. */
export const setupEvents = {
  progress: "setup:progress",
  finished: "setup:finished",
} as const;

/** Handle returned by a subscription; call it to stop listening. */
export type Unsubscribe = UnlistenFn;

/**
 * Coerce anything the bridge throws into an {@link IpcError}.
 *
 * Tauri rejects with the serialised command error, a string, or the error type itself
 * depending on where the failure happened, so all three shapes are normalised here.
 */
function normalise(error: unknown): IpcError {
  if (error instanceof IpcError) {
    return error;
  }
  if (typeof error === "string") {
    return new IpcError({ kind: "setup", message: error, detail: null });
  }
  if (error !== null && typeof error === "object" && "message" in error) {
    const candidate = error as { kind?: string; message: unknown; detail?: string | null };
    return new IpcError({
      kind: candidate.kind ?? "setup",
      message: String(candidate.message),
      detail: candidate.detail ?? null,
    });
  }
  return new IpcError({
    kind: "setup",
    message: "安装程序发生未知错误",
    detail: String(error),
  });
}

/** Invoke a setup command; rejects with an {@link IpcError} and nothing else. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw normalise(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

/** Everything the window needs to decide which page to show. */
export function getSetupContext(): Promise<SetupContext> {
  return call<SetupContext>("setup_context");
}

/** Native folder picker; resolves to `null` when the user cancels it. */
export function pickDirectory(current: string): Promise<string | null> {
  return call<string | null>("setup_pick_directory", { current });
}

/** Probe a candidate directory for writability and free space. */
export function checkDirectory(path: string): Promise<DirCheck> {
  return call<DirCheck>("setup_check_dir", { path });
}

/** Queues the install; the work itself reports through {@link onSetupProgress}. */
export function startInstall(options: InstallOptions): Promise<void> {
  return call<void>("setup_start_install", { options });
}

export function startUninstall(options: UninstallOptions): Promise<void> {
  return call<void>("setup_start_uninstall", { options });
}

/** Abort the running operation; the backend rolls back whatever it wrote. */
export function cancelSetup(): Promise<void> {
  return call<void>("setup_cancel");
}

/** Start the freshly installed application. */
export function launchApp(): Promise<void> {
  return call<void>("setup_launch_app");
}

/** Reveal a directory in the system file manager. */
export function openPath(path: string): Promise<void> {
  return call<void>("setup_open_path", { path });
}

/** Close the installer window. */
export function closeSetup(): Promise<void> {
  return call<void>("setup_close");
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

export function onSetupProgress(
  handler: (progress: SetupProgress) => void,
): Promise<Unsubscribe> {
  return listen<SetupProgress>(setupEvents.progress, (event) => handler(event.payload));
}

export function onSetupFinished(
  handler: (finished: SetupFinished) => void,
): Promise<Unsubscribe> {
  return listen<SetupFinished>(setupEvents.finished, (event) => handler(event.payload));
}

/* -------------------------------------------------------------------------- */
/* Error helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Summary a user can act on. */
export function errorMessage(error: unknown): string {
  if (error instanceof IpcError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Technical detail behind the failure, when the backend supplied one. */
export function errorDetail(error: unknown): string | null {
  return error instanceof IpcError ? error.detail : null;
}
