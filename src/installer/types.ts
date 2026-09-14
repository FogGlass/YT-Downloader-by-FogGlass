/**
 * The installer window's data contract.
 *
 * These types mirror the Rust command and event payloads one-for-one, so the frontend
 * never grows a second, competing model of what the setup backend sends.
 */

export type SetupMode = "install" | "uninstall";

export interface SetupContext {
  mode: SetupMode;
  appName: string;
  appVersion: string;
  /** Pre-computed default that avoids `C:` on machines with a second volume. */
  defaultDir: string;
  /** Set when `mode === "uninstall"`. */
  installDir: string | null;
  installedVersion: string | null;
  /** Compressed payload size as shipped. */
  payloadBytes: number;
  /** Size after extraction — what the target disk must be able to hold. */
  extractedBytes: number;
  payloadFiles: number;
  hasBundledRuntime: boolean;
}

export interface DirCheck {
  path: string;
  writable: boolean;
  exists: boolean;
  freeBytes: number | null;
  sufficientSpace: boolean;
  /** Human-readable problem, or `null` when the directory is usable. */
  message: string | null;
}

export interface InstallOptions {
  dir: string;
  startMenuShortcut: boolean;
  desktopShortcut: boolean;
  launchAfterInstall: boolean;
}

export interface UninstallOptions {
  /** Config, history, favorites, logs, cache, temp and the webview data directory. */
  removeAppData: boolean;
  /** `data\downloads` — destructive, so the UI never defaults it to on. */
  removeDownloads: boolean;
}

export type StepState = "pending" | "active" | "done" | "failed";

export interface SetupStep {
  id: string;
  label: string;
  state: StepState;
}

export interface SetupProgress {
  /** 0 – 1. */
  percent: number;
  steps: SetupStep[];
  /** The file or step being worked on right now, e.g. `runtime/FFMPEG-9.0/bin/ffmpeg.exe`. */
  detail: string;
}

export interface SetupFinished {
  ok: boolean;
  mode: SetupMode;
  installDir: string | null;
  error: string | null;
  detail: string | null;
  appDataKept: boolean;
  downloadsKept: boolean;
}

/**
 * The pages the installer window can show.
 *
 * `options` and `uninstall` are the two entry points, `running` is shared by install and
 * uninstall, and `done` renders whichever outcome `setup:finished` reported.
 */
export type SetupPhase = "options" | "uninstall" | "running" | "done";
