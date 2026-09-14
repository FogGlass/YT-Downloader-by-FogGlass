/**
 * The data contract shared with the Rust backend.
 *
 * Field names mirror the `#[serde(rename_all = "camelCase")]` models one-for-one, so
 * this file is the single place to look when a payload changes.
 */

export type MediaKind = "video" | "playlist" | "channel";

export type ThemeMode = "dark" | "light" | "system";
export type MotionPreference = "system" | "full" | "reduced";
export type CookieMode = "none" | "browser" | "file";
export type ProxyMode = "none" | "system" | "manual";
export type YtDlpRuntimeMode = "auto" | "executable" | "pythonModule";
export type MergeContainer = "auto" | "matroska" | "mp4" | "webm";
export type CodecPreference = "auto" | "av1" | "vp9" | "h264";
export type AudioCodecPreference = "auto" | "opus" | "aac";

export type TaskState =
  | "queued"
  | "probing"
  | "downloading"
  | "merging"
  | "completed"
  | "paused"
  | "cancelled"
  | "failed";

export type StreamRole = "video" | "audio" | "single";

export type FormatOptionKind =
  | "progressive"
  | "videoWithAudio"
  | "videoOnly"
  | "audioOnly";

export interface ThumbnailInfo {
  url: string;
  width: number | null;
  height: number | null;
  preference: number | null;
}

export interface FormatInfo {
  formatId: string;
  ext: string;
  vcodec: string | null;
  acodec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  dynamicRange: string | null;
  tbr: number | null;
  vbr: number | null;
  abr: number | null;
  audioChannels: number | null;
  audioSampleRate: number | null;
  filesize: number | null;
  filesizeApprox: number | null;
  protocol: string | null;
  language: string | null;
  formatNote: string | null;
  quality: number | null;
}

export interface FormatOption {
  id: string;
  kind: FormatOptionKind;
  label: string;
  detail: string;
  height: number | null;
  width: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string;
  hdr: boolean;
  dynamicRange: string | null;
  videoFormatId: string | null;
  audioFormatId: string | null;
  singleFormatId: string | null;
  bitrateMbps: number | null;
  sizeBytes: number | null;
  audioBitrate: number | null;
  recommended: boolean;
  available: boolean;
  note: string | null;
}

export interface SubtitleInfo {
  language: string;
  name: string | null;
  formats: string[];
}

export interface ChapterInfo {
  title: string;
  startTime: number;
  endTime: number | null;
}

export interface PlaylistEntry {
  id: string;
  title: string;
  url: string;
  duration: number | null;
  thumbnail: string | null;
  uploader: string | null;
}

export interface MediaProbe {
  kind: MediaKind;
  id: string;
  title: string;
  webpageUrl: string;
  uploader: string | null;
  channelUrl: string | null;
  duration: number | null;
  description: string | null;
  uploadDate: string | null;
  viewCount: number | null;
  likeCount: number | null;
  isLive: boolean;
  wasLive: boolean;
  extractor: string | null;
  thumbnail: string | null;
  thumbnails: ThumbnailInfo[];
  formats: FormatInfo[];
  subtitles: SubtitleInfo[];
  automaticCaptions: SubtitleInfo[];
  chapters: ChapterInfo[];
  entries: PlaylistEntry[];
  playlistCount: number | null;
  options: FormatOption[];
}

export interface StreamProgress {
  role: StreamRole;
  formatId: string;
  ext: string;
  downloadedBytes: number;
  totalBytes: number | null;
  speed: number | null;
  eta: number | null;
  path: string | null;
  finished: boolean;
}

export interface DownloadProgress {
  percent: number;
  downloadedBytes: number;
  totalBytes: number | null;
  speed: number | null;
  eta: number | null;
  stage: string;
  stagePercent: number | null;
}

export interface DownloadResult {
  filePath: string;
  fileName: string;
  directory: string;
  sizeBytes: number;
  container: string;
  durationSeconds: number | null;
  thumbnailPath: string | null;
  subtitlePaths: string[];
  mergedFrom: string[];
}

export interface TaskError {
  summary: string;
  detail: string | null;
  /** Actionable guidance, e.g. "close Edge and retry" or "use cookies.txt". */
  hint?: string | null;
  kind: string;
  exitCode: number | null;
  command: string | null;
}

export interface FormatSelection {
  kind: string;
  label: string;
  container: string;
  videoFormatId: string | null;
  audioFormatId: string | null;
  singleFormatId: string | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hdr: boolean;
  sizeBytes: number | null;
  mode: string;
}

export interface DownloadTask {
  id: string;
  url: string;
  title: string;
  thumbnail: string | null;
  uploader: string | null;
  duration: number | null;
  kind: MediaKind;
  state: TaskState;
  progress: DownloadProgress;
  streams: StreamProgress[];
  selection: FormatSelection;
  output: DownloadResult | null;
  error: TaskError | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  playlistIndex: number | null;
  playlistCount: number | null;
  playlistTitle: string | null;
  notices: string[];
  mergeReady: boolean;
  commandPreview: string | null;
}

export interface DownloadRequest {
  url: string;
  selection?: FormatSelection | null;
  playlistIndices?: number[] | null;
  outputDir?: string | null;
  titleHint?: string | null;
  thumbnailHint?: string | null;
  uploaderHint?: string | null;
  durationHint?: number | null;
  /** Skip browser cookies for this task only (the "retry without cookies" fallback). */
  ignoreCookies?: boolean | null;
}

export interface BrowserInfo {
  key: string;
  name: string;
  installed: boolean;
  userDataDir: string | null;
  profiles: string[];
  /** Chromium 127+ protects cookie values with a key only the browser can use. */
  appBoundEncryption: boolean;
}

export interface CookieStatus {
  configuredMode: "none" | "browser" | "file";
  browserKey: string;
  browserName: string;
  profile: string;
  databasePath: string | null;
  databaseExists: boolean;
  databaseSizeBytes: number;
  /** True when the browser holds the database open. */
  locked: boolean;
  browserRunning: boolean;
  appBoundEncryption: boolean;
  installedBrowsers: BrowserInfo[];
  message: string;
  hint: string | null;
}

export interface CookieFileCheck {
  path: string;
  exists: boolean;
  readable: boolean;
  looksLikeCookiejar: boolean;
  message: string;
}

export type HistoryStatus = "completed" | "failed" | "cancelled";

export interface HistoryEntry {
  id: string;
  taskId: string;
  url: string;
  title: string;
  thumbnail: string | null;
  uploader: string | null;
  duration: number | null;
  filePath: string | null;
  directory: string | null;
  sizeBytes: number;
  container: string | null;
  status: HistoryStatus;
  selectionLabel: string | null;
  error: string | null;
  finishedAt: string;
  subtitlePaths: string[];
  mergedFrom: string[];
}

export interface FavoriteEntry {
  id: string;
  url: string;
  title: string;
  thumbnail: string | null;
  uploader: string | null;
  duration: number | null;
  createdAt: string;
  note: string | null;
}

export interface UrlCheck {
  url: string;
  valid: boolean;
  reason: string | null;
  playlist: boolean;
}

export interface ToolStatus {
  name: string;
  path: string | null;
  version: string | null;
  available: boolean;
  error: string | null;
}

export interface RuntimeStatus {
  binDir: string;
  source: string;
  ytDlpMode: string;
  /** External JS runtime handed to yt-dlp; null when none was found. */
  jsRuntime: string | null;
  ytDlp: ToolStatus;
  ffmpeg: ToolStatus;
  ffprobe: ToolStatus;
  complete: boolean;
  warnings: string[];
  checkedAt: string;
}

export interface LogEntry {
  at: string;
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  message: string;
}

export interface StorageInfo {
  root: string;
  settingsFile: string;
  historyFile: string;
  favoritesFile: string;
  logFile: string;
  tempDir: string;
  cacheDir: string;
  downloadDir: string;
  logSizeBytes: number;
}

export interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
  buildProfile: string;
  target: string;
  identifier: string;
}

export interface PathFacts {
  exists: boolean;
  isFile: boolean;
  isDir: boolean;
  sizeBytes: number;
  modifiedAt: string | null;
  writable: boolean;
}

export interface QueueSummary {
  total: number;
  queued: number;
  active: number;
  completed: number;
  failed: number;
  paused: number;
}

export interface EnqueueResult {
  ids: string[];
  queued: number;
}

export interface GeneralSettings {
  confirmBeforeExit: boolean;
  watchClipboard: boolean;
  notifyOnComplete: boolean;
  restoreLastPage: boolean;
  lastPage: string;
}

export interface DownloadSettings {
  outputDir: string;
  filenameTemplate: string;
  playlistSubfolder: boolean;
  concurrency: number;
  mergeContainer: MergeContainer;
  keepStreams: boolean;
  writeThumbnail: boolean;
  embedThumbnail: boolean;
  embedMetadata: boolean;
  embedChapters: boolean;
  writeSubtitles: boolean;
  subtitleLanguages: string;
  writeAutoSubtitles: boolean;
  writeDescription: boolean;
}

export interface YoutubeSettings {
  videoCodecPreference: CodecPreference;
  audioCodecPreference: AudioCodecPreference;
  maxHeight: string;
  preferHdr: boolean;
  prefer60fps: boolean;
  jsRuntime: string;
  extractorArgs: string;
}

export interface CookieSettings {
  mode: CookieMode;
  browser: string;
  profile: string;
  file: string;
}

export interface NetworkSettings {
  proxyMode: ProxyMode;
  proxyUrl: string;
  rateLimitKib: number;
  retries: number;
  fragmentRetries: number;
  concurrentFragments: number;
  socketTimeoutSeconds: number;
  forceIpv4: boolean;
  noCheckCertificates: boolean;
}

export interface AppearanceSettings {
  theme: ThemeMode;
  accent: string;
  compact: boolean;
  motion: MotionPreference;
  ambientBackground: boolean;
  nativeDecorations: boolean;
  showSidebarLabels: boolean;
}

export interface AdvancedSettings {
  toolsDir: string;
  ytdlpMode: YtDlpRuntimeMode;
  pythonPath: string;
  pythonModuleDir: string;
  ytdlpExtraArgs: string;
  ffmpegExtraArgs: string;
  expertMode: boolean;
  logLevel: string;
  keepRawOutput: boolean;
}

export interface LimitSettings {
  maxPlaylistItems: number;
  playlistStart: number;
  maxFilesizeMib: number;
  skipExisting: boolean;
  downloadSections: string;
}

export interface AppSettings {
  general: GeneralSettings;
  downloads: DownloadSettings;
  youtube: YoutubeSettings;
  cookies: CookieSettings;
  network: NetworkSettings;
  appearance: AppearanceSettings;
  advanced: AdvancedSettings;
  limits: LimitSettings;
}

export type SettingsPatch = Partial<AppSettings>;

export interface BackendError {
  kind: string;
  message: string;
  detail?: string | null;
  /** Actionable guidance when the backend classified the failure. */
  hint?: string | null;
}
