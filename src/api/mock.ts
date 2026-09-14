/**
 * Browser preview backend.
 *
 * The packaged application always talks to Rust: inside Tauri `isDesktop()` is true and
 * this module is never reached. When the same UI is opened in a plain browser (for
 * design review, screenshot checks and layout assertions) there is no IPC bridge, so
 * this file answers the same commands from memory.
 *
 * It is deliberately honest about what it is: fixtures, not a download engine. It
 * exists so the interface can be exercised — including every task state — without a
 * window, and it never pretends to download anything.
 */

import type {
  AppInfo,
  AppSettings,
  DownloadRequest,
  DownloadTask,
  FavoriteEntry,
  FormatOption,
  HistoryEntry,
  LogEntry,
  MediaProbe,
  QueueSummary,
  RuntimeStatus,
  SettingsPatch,
  StorageInfo,
  TaskState,
  UrlCheck,
} from "@/types/models";

const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

const DEFAULT_SETTINGS: AppSettings = {
  general: {
    confirmBeforeExit: false,
    watchClipboard: true,
    notifyOnComplete: true,
    restoreLastPage: true,
    lastPage: "home",
  },
  downloads: {
    outputDir: "E:\\DeepSeek Harness Workspace\\YTDownloader\\data\\downloads",
    filenameTemplate: "%(title)s.%(ext)s",
    playlistSubfolder: true,
    concurrency: 2,
    mergeContainer: "auto",
    keepStreams: false,
    writeThumbnail: false,
    embedThumbnail: true,
    embedMetadata: true,
    embedChapters: true,
    writeSubtitles: false,
    subtitleLanguages: "zh-Hans,zh-Hant,en",
    writeAutoSubtitles: false,
    writeDescription: false,
  },
  youtube: {
    videoCodecPreference: "auto",
    audioCodecPreference: "auto",
    maxHeight: "",
    preferHdr: false,
    prefer60fps: true,
    jsRuntime: "",
    extractorArgs: "",
  },
  cookies: { mode: "none", browser: "edge", profile: "", file: "" },
  network: {
    proxyMode: "none",
    proxyUrl: "",
    rateLimitKib: 0,
    retries: 10,
    fragmentRetries: 10,
    concurrentFragments: 4,
    socketTimeoutSeconds: 30,
    forceIpv4: false,
    noCheckCertificates: false,
  },
  appearance: {
    theme: "dark",
    accent: "violet",
    compact: false,
    motion: "system",
    ambientBackground: true,
    nativeDecorations: false,
    showSidebarLabels: true,
  },
  advanced: {
    toolsDir: "",
    ytdlpMode: "auto",
    pythonPath: "",
    pythonModuleDir: "",
    ytdlpExtraArgs: "",
    ffmpegExtraArgs: "",
    expertMode: true,
    logLevel: "info",
    keepRawOutput: false,
  },
  limits: {
    maxPlaylistItems: 0,
    playlistStart: 1,
    maxFilesizeMib: 0,
    skipExisting: false,
    downloadSections: "",
  },
};

/** A realistic format table so the selector has something meaningful to render. */
function fixtureOptions(): FormatOption[] {
  const video = (
    height: number,
    codec: string,
    container: string,
    bitrate: number,
    videoId: string,
    audioCodec: string,
    audioId: string,
    size: number,
    hdr = false,
    fps = 30,
  ): FormatOption => ({
    id: `${videoId}+${audioId}`,
    kind: "videoWithAudio",
    label: height ? `${height}p${fps >= 50 ? fps : ""}` : "音频",
    detail: `${codec} · ${audioCodec} · ${bitrate.toFixed(1)} Mbps${hdr ? " · HDR" : ""}`,
    height,
    width: Math.round((height * 16) / 9),
    fps,
    videoCodec: codec,
    audioCodec,
    container,
    hdr,
    dynamicRange: hdr ? "HDR10" : "SDR",
    videoFormatId: videoId,
    audioFormatId: audioId,
    singleFormatId: null,
    bitrateMbps: bitrate,
    sizeBytes: size,
    audioBitrate: 130,
    recommended: false,
    available: true,
    note: null,
  });

  const options: FormatOption[] = [
    video(2160, "AV1", "mkv", 24.5, "401", "Opus", "251", 1_240_000_000, true, 60),
    video(2160, "VP9", "webm", 26.8, "337", "Opus", "251", 1_360_000_000, true, 60),
    video(1440, "VP9", "webm", 12.8, "271", "Opus", "251", 640_000_000, false, 60),
    video(1080, "VP9", "webm", 8.2, "248", "Opus", "251", 410_000_000, false, 60),
    video(1080, "AV1", "mkv", 6.4, "399", "Opus", "251", 320_000_000, false, 60),
    video(1080, "H.264", "mp4", 9.6, "137", "AAC", "140", 480_000_000, false, 30),
    video(720, "VP9", "webm", 4.1, "247", "Opus", "251", 205_000_000, false, 30),
    video(480, "VP9", "webm", 2.2, "244", "Opus", "251", 110_000_000, false, 30),
    {
      id: "18",
      kind: "progressive",
      label: "360p",
      detail: "H.264 · AAC · 0.7 Mbps",
      height: 360,
      width: 640,
      fps: 30,
      videoCodec: "H.264",
      audioCodec: "AAC",
      container: "mp4",
      hdr: false,
      dynamicRange: "SDR",
      videoFormatId: null,
      audioFormatId: null,
      singleFormatId: "18",
      bitrateMbps: 0.7,
      sizeBytes: 35_000_000,
      audioBitrate: 96,
      recommended: false,
      available: true,
      note: "单文件",
    },
    {
      id: "251",
      kind: "audioOnly",
      label: "Opus",
      detail: "Opus · 130 kbps · 2 声道",
      height: null,
      width: null,
      fps: null,
      videoCodec: null,
      audioCodec: "Opus",
      container: "webm",
      hdr: false,
      dynamicRange: null,
      videoFormatId: null,
      audioFormatId: null,
      singleFormatId: "251",
      bitrateMbps: null,
      sizeBytes: 12_400_000,
      audioBitrate: 130,
      recommended: false,
      available: true,
      note: "仅音频",
    },
    {
      id: "140",
      kind: "audioOnly",
      label: "AAC",
      detail: "AAC · 128 kbps · 2 声道",
      height: null,
      width: null,
      fps: null,
      videoCodec: null,
      audioCodec: "AAC",
      container: "mp4",
      hdr: false,
      dynamicRange: null,
      videoFormatId: null,
      audioFormatId: null,
      singleFormatId: "140",
      bitrateMbps: null,
      sizeBytes: 12_100_000,
      audioBitrate: 128,
      recommended: false,
      available: true,
      note: "仅音频",
    },
  ];

  // The backend marks exactly one row as the smart default.
  const recommended = options.findIndex((option) => option.id === "248+251");
  if (recommended >= 0) {
    options[recommended] = { ...options[recommended], recommended: true };
  }
  return options;
}

function fixtureProbe(url: string, kind: MediaProbe["kind"] = "video"): MediaProbe {
  const options = fixtureOptions();
  const isCollection = kind !== "video";

  return {
    kind,
    id: "aqz-KE-bpKQ",
    title: isCollection
      ? "Blender 开放电影合集"
      : "Big Buck Bunny — 开源动画短片（4K 修复版）",
    webpageUrl: url,
    uploader: "Blender Foundation",
    channelUrl: "https://www.youtube.com/@BlenderFoundation",
    duration: isCollection ? 3812 : 635,
    description: "由 Blender Foundation 发布的创作共用（CC-BY）测试影片。",
    uploadDate: "20080410",
    viewCount: isCollection ? 4_820_113 : 12_480_337,
    likeCount: 245_000,
    isLive: false,
    wasLive: false,
    extractor: "Youtube",
    thumbnail: "https://i.ytimg.com/vi/aqz-KE-bpKQ/maxresdefault.jpg",
    thumbnails: [],
    formats: [],
    subtitles: [
      { language: "zh-Hans", name: "中文（简体）", formats: ["vtt", "srv3"] },
      { language: "en", name: "English", formats: ["vtt"] },
    ],
    automaticCaptions: [{ language: "en", name: null, formats: ["vtt"] }],
    chapters: [
      { title: "开场", startTime: 0, endTime: 42 },
      { title: "森林清晨", startTime: 42, endTime: 186 },
      { title: "蝴蝶", startTime: 186, endTime: 400 },
      { title: "尾声", startTime: 400, endTime: 635 },
    ],
    entries: isCollection
      ? Array.from({ length: 12 }).map((_, index) => ({
          id: `entry-${index}`,
          title: [
            "Big Buck Bunny",
            "Sintel",
            "Elephants Dream",
            "Tears of Steel",
            "Cosmos Laundromat",
            "Spring",
            "Agent 327",
            "Caminandes: Llamigos",
            "Hero",
            "Coffee Run",
            "Sprite Fright",
            "Charge",
          ][index],
          url: `https://www.youtube.com/watch?v=entry-${index}`,
          duration: [635, 888, 654, 734, 728, 465, 231, 150, 240, 190, 620, 240][index],
          thumbnail: null,
          uploader: "Blender Foundation",
        }))
      : [],
    playlistCount: isCollection ? 12 : null,
    options: isCollection ? [] : options,
  };
}

const TASK_BLUEPRINTS: Array<{
  title: string;
  state: TaskState;
  label: string;
  video: string;
  audio: string;
  container: string;
  percent: number;
  stage: string;
  size: number;
}> = [
  {
    title: "Big Buck Bunny — 开源动画短片（4K 修复版）",
    state: "downloading",
    label: "1080p60",
    video: "VP9",
    audio: "Opus",
    container: "webm",
    percent: 0.42,
    stage: "下载中 1/2",
    size: 410_000_000,
  },
  {
    title: "Sintel — 开源动画短片",
    state: "merging",
    label: "1440p60",
    video: "VP9",
    audio: "Opus",
    container: "mkv",
    percent: 1,
    stage: "合并中",
    size: 640_000_000,
  },
  {
    title: "Elephants Dream — 第一部开放电影",
    state: "queued",
    label: "2160p",
    video: "AV1",
    audio: "Opus",
    container: "mkv",
    percent: 0,
    stage: "等待中",
    size: 1_240_000_000,
  },
  {
    title: "Tears of Steel — 混合实拍与 CG",
    state: "paused",
    label: "1080p",
    video: "H.264",
    audio: "AAC",
    container: "mp4",
    percent: 0.63,
    stage: "已暂停",
    size: 480_000_000,
  },
  {
    title: "Cosmos Laundromat — 第一循环",
    state: "completed",
    label: "1080p60",
    video: "VP9",
    audio: "Opus",
    container: "mkv",
    percent: 1,
    stage: "已完成",
    size: 268_000_000,
  },
  {
    title: "Spring — 关于少女与狗的诗意短片",
    state: "failed",
    label: "1440p",
    video: "VP9",
    audio: "Opus",
    container: "mkv",
    percent: 1,
    stage: "失败",
    size: 305_000_000,
  },
];

function blueprintTask(index: number): DownloadTask {
  const blueprint = TASK_BLUEPRINTS[index];
  const isSplit = !["mp4"].includes(blueprint.container) || blueprint.label !== "360p";
  const needsMerge = isSplit && blueprint.video !== "H.264";
  const done = blueprint.state === "completed";

  return {
    id: `fixture-${index}`,
    url: `https://www.youtube.com/watch?v=fixture${index}`,
    title: blueprint.title,
    thumbnail: `https://i.ytimg.com/vi/aqz-KE-bpKQ/hq${index % 3 === 0 ? "default" : "720"}.jpg`,
    uploader: "Blender Foundation",
    duration: 300 + index * 60,
    kind: "video",
    state: blueprint.state,
    progress: {
      percent: blueprint.percent,
      downloadedBytes: Math.round(blueprint.size * blueprint.percent),
      totalBytes: blueprint.size,
      speed: blueprint.state === "downloading" ? 8_400_000 + index * 120_000 : null,
      eta: blueprint.state === "downloading" ? 42 + index * 9 : null,
      stage: blueprint.stage,
      stagePercent: blueprint.percent,
    },
    streams: [
      {
        role: "video",
        formatId: "248",
        ext: "webm",
        downloadedBytes: Math.round(blueprint.size * blueprint.percent * 0.86),
        totalBytes: Math.round(blueprint.size * 0.86),
        speed: 7_200_000,
        eta: 40,
        path: `E:\\out\\clip-${index}.video.webm`,
        finished: blueprint.percent >= 1,
      },
      {
        role: "audio",
        formatId: "251",
        ext: "webm",
        downloadedBytes: Math.round(blueprint.size * blueprint.percent * 0.14),
        totalBytes: Math.round(blueprint.size * 0.14),
        speed: 1_100_000,
        eta: 12,
        path: `E:\\out\\clip-${index}.audio.webm`,
        finished: blueprint.percent >= 1,
      },
    ],
    selection: {
      kind: "videoWithAudio",
      label: blueprint.label,
      container: blueprint.container,
      videoFormatId: "248",
      audioFormatId: "251",
      singleFormatId: null,
      height: 1080,
      fps: 60,
      videoCodec: blueprint.video,
      audioCodec: blueprint.audio,
      hdr: false,
      sizeBytes: blueprint.size,
      mode: needsMerge ? "video+audio" : "single",
    },
    output: done
      ? {
          filePath: `E:\\out\\${blueprint.title.slice(0, 18)}.mkv`,
          fileName: `${blueprint.title.slice(0, 18)}.mkv`,
          directory: "E:\\out",
          sizeBytes: blueprint.size,
          container: "mkv",
          durationSeconds: 300 + index * 60,
          thumbnailPath: null,
          subtitlePaths: [],
          mergedFrom: ["248", "251"],
        }
      : null,
    error:
      blueprint.state === "failed"
        ? {
            summary: "合并失败：FFmpeg 退出码 1",
            detail:
              "[matroska @ 0000] Error writing trailer: Invalid argument\nav_interleaved_write_frame(): Invalid argument",
            kind: "merge",
            exitCode: 1,
            command:
              'ffmpeg -hide_banner -nostdin -y -i "E:\\out\\clip-5.video.webm" -i "E:\\out\\clip-5.audio.webm" -map 0:v:0 -map 1:a:0 -c copy "E:\\out\\clip-5.mkv"',
          }
        : null,
    createdAt: now(),
    startedAt: now(),
    finishedAt: blueprint.state === "completed" || blueprint.state === "failed" ? now() : null,
    attempts: 1,
    playlistIndex: null,
    playlistCount: null,
    playlistTitle: null,
    notices:
      blueprint.state === "failed"
        ? ["视频与音频已下载完成，可只重试合并"]
        : blueprint.state === "paused"
          ? ["复用已下载的分片"]
          : [],
    mergeReady: blueprint.state === "failed",
    commandPreview: null,
  };
}

function fixtureHistory(): HistoryEntry[] {
  return TASK_BLUEPRINTS.map((blueprint, index) => ({
    id: `history-${index}`,
    taskId: `fixture-${index}`,
    url: `https://www.youtube.com/watch?v=fixture${index}`,
    title: blueprint.title,
    thumbnail: `https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg`,
    uploader: "Blender Foundation",
    duration: 300 + index * 60,
    filePath:
      blueprint.state === "completed" || blueprint.state === "failed"
        ? `E:\\out\\${blueprint.title.slice(0, 18)}.mkv`
        : null,
    directory: "E:\\out",
    sizeBytes: blueprint.state === "completed" ? blueprint.size : 0,
    container: blueprint.container,
    status:
      blueprint.state === "completed"
        ? "completed"
        : blueprint.state === "failed"
          ? "failed"
          : index === 3
            ? "cancelled"
            : "completed",
    selectionLabel: `${blueprint.label} · ${blueprint.video} · ${blueprint.audio}`,
    error: blueprint.state === "failed" ? "合并失败：FFmpeg 退出码 1" : null,
    finishedAt: now(),
    subtitlePaths: index === 0 ? ["E:\\out\\clip-0.zh-Hans.srt"] : [],
    mergedFrom: ["248", "251"],
  }));
}

/** ------------------------------------------------------------------------ */

interface MockTask {
  task: DownloadTask;
  timer?: number;
}

class MockBackend {
  private settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
  private tasks: MockTask[] = [];
  private favorites: FavoriteEntry[] = [];
  private logs: LogEntry[] = [];

  constructor() {
    this.tasks = TASK_BLUEPRINTS.map((_, index) => ({ task: blueprintTask(index) }));
  }

  private find(id: string): MockTask | undefined {
    return this.tasks.find((entry) => entry.task.id === id);
  }

  /** Simulate forward progress so the queue UI can be exercised live. */
  private startTicker(entry: MockTask): void {
    if (entry.timer !== undefined) {
      return;
    }
    entry.timer = window.setInterval(() => {
      const { task } = entry;
      if (task.state !== "downloading" && task.state !== "merging") {
        window.clearInterval(entry.timer);
        entry.timer = undefined;
        return;
      }
      const step = 0.004 + Math.random() * 0.008;
      const percent = Math.min(1, task.progress.percent + step);
      task.progress = {
        ...task.progress,
        percent,
        downloadedBytes: Math.round((task.progress.totalBytes ?? 0) * percent),
        speed: 6_000_000 + Math.random() * 6_000_000,
        eta: Math.max(1, Math.round((1 - percent) * 240)),
      };
      if (percent >= 1 && task.selection.mode === "video+audio") {
        task.state = "merging";
        task.progress.stage = "合并中";
      } else if (percent >= 1) {
        task.state = "completed";
        task.progress.stage = "已完成";
      }
    }, 900);
  }

  private apply(id: string, mutate: (task: DownloadTask) => void): DownloadTask | null {
    const entry = this.find(id);
    if (!entry) {
      return null;
    }
    mutate(entry.task);
    return entry.task;
  }

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const payload = (args ?? {}) as Record<string, never>;
    switch (command) {
      case "validate_urls": {
        const text = String(payload.text ?? "");
        const checks: UrlCheck[] = [];
        for (const line of text.split("\n")) {
          const candidate = line.trim();
          if (!candidate) {
            continue;
          }
          const valid = /^https?:\/\/\S+\.\S+/.test(candidate);
          const url = candidate;
          if (!checks.some((check) => check.url === url)) {
            checks.push({
              url,
              valid,
              reason: valid ? null : "不是有效的链接",
              playlist:
                valid && (url.includes("list=") || url.includes("/@") || url.includes("/playlist")),
            });
          }
        }
        return checks as unknown as T;
      }
      case "probe_url": {
        const url = String(payload.url ?? "");
        const playlist = Boolean(payload.playlist);
        return fixtureProbe(url, playlist ? "playlist" : "video") as unknown as T;
      }
      case "probe_playlist":
        return fixtureProbe(String(payload.url ?? ""), "playlist") as unknown as T;
      case "cancel_probe":
        return false as unknown as T;
      case "supported_link_examples":
        return [
          "https://www.youtube.com/watch?v=…",
          "https://youtu.be/…",
          "https://www.youtube.com/shorts/…",
          "https://www.youtube.com/playlist?list=…",
          "https://www.youtube.com/@channel/videos",
        ] as unknown as T;
      case "data_root":
        return this.settings.downloads.outputDir as unknown as T;

      case "list_tasks":
        return this.tasks.map((entry) => entry.task) as unknown as T;
      case "get_task":
        return (this.find(String(payload.id))?.task ?? null) as unknown as T;
      case "enqueue_downloads": {
        const requests = (payload.requests ?? []) as unknown as DownloadRequest[];
        const ids: string[] = [];
        for (const request of requests) {
          const id = `mock-${Date.now()}-${ids.length}`;
          const task = blueprintTask(0);
          const probe = fixtureProbe(request.url);
          task.id = id;
          task.url = request.url;
          task.title = request.titleHint ?? probe.title;
          task.thumbnail = request.thumbnailHint ?? probe.thumbnail;
          task.uploader = request.uploaderHint ?? probe.uploader;
          task.duration = request.durationHint ?? probe.duration;
          task.state = "downloading";
          task.progress = {
            percent: 0,
            downloadedBytes: 0,
            totalBytes: task.selection.sizeBytes,
            speed: 0,
            eta: null,
            stage: "下载中 1/2",
            stagePercent: 0,
          };
          task.output = null;
          task.error = null;
          task.mergeReady = false;
          task.notices = ["浏览器预览模式：不会真的下载"];
          const entry: MockTask = { task };
          this.tasks.unshift(entry);
          this.startTicker(entry);
          ids.push(id);
        }
        return { ids, queued: ids.length } as unknown as T;
      }
      case "pause_task":
        return this.apply(String(payload.id), (task) => {
          task.state = "paused";
          task.progress.stage = "已暂停";
          task.progress.speed = null;
          task.progress.eta = null;
        }) as unknown as T;
      case "resume_task":
        return this.apply(String(payload.id), (task) => {
          task.state = "downloading";
          task.progress.stage = "下载中 1/2";
        }) as unknown as T;
      case "cancel_task":
        return this.apply(String(payload.id), (task) => {
          task.state = "cancelled";
          task.progress.stage = "已取消";
          task.progress.speed = null;
        }) as unknown as T;
      case "retry_task":
        return this.apply(String(payload.id), (task) => {
          task.state = "downloading";
          task.error = null;
          task.mergeReady = false;
          task.progress = { ...task.progress, stage: "下载中 1/2", speed: 4_000_000 };
        }) as unknown as T;
      case "retry_merge": {
        const entry = this.find(String(payload.id));
        if (entry) {
          entry.task.state = "merging";
          entry.task.error = null;
          entry.task.progress = { ...entry.task.progress, stage: "合并中", percent: 0 };
          window.setTimeout(() => {
            entry.task.state = "completed";
            entry.task.progress = { ...entry.task.progress, percent: 1, stage: "已完成" };
            entry.task.output = {
              filePath: `E:\\out\\${entry.task.title.slice(0, 18)}.mkv`,
              fileName: `${entry.task.title.slice(0, 18)}.mkv`,
              directory: "E:\\out",
              sizeBytes: entry.task.progress.totalBytes ?? 0,
              container: "mkv",
              durationSeconds: entry.task.duration,
              thumbnailPath: null,
              subtitlePaths: [],
              mergedFrom: ["248", "251"],
            };
            entry.task.mergeReady = false;
          }, 2200);
        }
        return undefined as unknown as T;
      }
      case "remove_task": {
        const id = String(payload.id);
        this.tasks = this.tasks.filter((entry) => entry.task.id !== id);
        return undefined as unknown as T;
      }
      case "clear_finished_tasks": {
        const before = this.tasks.length;
        this.tasks = this.tasks.filter(
          (entry) => !["completed", "cancelled"].includes(entry.task.state),
        );
        return (before - this.tasks.length) as unknown as T;
      }
      case "queue_summary": {
        const summary: QueueSummary = {
          total: this.tasks.length,
          queued: 0,
          active: 0,
          completed: 0,
          failed: 0,
          paused: 0,
        };
        for (const { task } of this.tasks) {
          if (task.state === "queued") summary.queued += 1;
          else if (["downloading", "merging", "probing"].includes(task.state)) summary.active += 1;
          else if (task.state === "completed") summary.completed += 1;
          else if (task.state === "failed") summary.failed += 1;
          else if (task.state === "paused") summary.paused += 1;
        }
        return summary as unknown as T;
      }

      case "history_list":
        return fixtureHistory() as unknown as T;
      case "history_remove":
      case "history_clear":
        return (command === "history_remove" ? true : 1) as unknown as T;
      case "favorites_list":
        return this.favorites as unknown as T;
      case "favorites_upsert": {
        const entry = payload.entry as unknown as FavoriteEntry;
        const existing = this.favorites.findIndex((item) => item.url === entry.url);
        const stored: FavoriteEntry = {
          ...entry,
          id: entry.id || `fav-${Date.now()}`,
          createdAt: entry.createdAt || now(),
        };
        if (existing >= 0) {
          this.favorites[existing] = stored;
        } else {
          this.favorites.unshift(stored);
        }
        return this.favorites as unknown as T;
      }
      case "favorites_remove":
        this.favorites = this.favorites.filter((item) => item.id !== String(payload.id));
        return this.favorites as unknown as T;
      case "favorites_contains":
        return this.favorites.some((item) => item.url === String(payload.url)) as unknown as T;

      case "get_settings":
        return structuredClone(this.settings) as unknown as T;
      case "update_settings": {
        const patch = payload.patch as unknown as SettingsPatch;
        this.settings = { ...this.settings, ...patch };
        return structuredClone(this.settings) as unknown as T;
      }
      case "reset_settings":
        this.settings = structuredClone(DEFAULT_SETTINGS);
        return structuredClone(this.settings) as unknown as T;
      case "recent_logs": {
        if (this.logs.length === 0) {
          this.logs = [
            { at: now(), level: "info", scope: "app", message: "浏览器预览模式启动" },
            {
              at: now(),
              level: "info",
              scope: "runtime",
              message:
                "runtime check: dir=E:\\FFMPEG-9.0\\bin source=development mode=executable yt-dlp=2026.08.19 ffmpeg=2026-08-03-git-01a25f74cc-full_build",
            },
            { at: now(), level: "debug", scope: "ytdlp", message: "probing https://youtu.be/…" },
          ];
        }
        return this.logs as unknown as T;
      }
      case "clear_logs":
        this.logs = [];
        return undefined as unknown as T;
      case "storage_info": {
        const info: StorageInfo = {
          root: "E:\\DeepSeek Harness Workspace\\YTDownloader\\data",
          settingsFile: "…\\data\\config\\settings.json",
          historyFile: "…\\data\\history\\history.json",
          favoritesFile: "…\\data\\favorites\\favorites.json",
          logFile: "…\\data\\logs\\yt-downloader.log",
          tempDir: "…\\data\\temp",
          cacheDir: "…\\data\\cache",
          downloadDir: this.settings.downloads.outputDir,
          logSizeBytes: 18_432,
        };
        return info as unknown as T;
      }

      case "runtime_status": {
        const status: RuntimeStatus = {
          binDir: "E:\\FFMPEG-9.0\\bin",
          source: "development",
          ytDlpMode: "executable",
          jsRuntime: "node",
          ytDlp: {
            name: "yt-dlp",
            path: "E:\\FFMPEG-9.0\\bin\\yt-dlp.exe",
            version: "2026.08.19",
            available: true,
            error: null,
          },
          ffmpeg: {
            name: "ffmpeg",
            path: "E:\\FFMPEG-9.0\\bin\\ffmpeg.exe",
            version: "2026-08-03-git-01a25f74cc-full_build",
            available: true,
            error: null,
          },
          ffprobe: {
            name: "ffprobe",
            path: "E:\\FFMPEG-9.0\\bin\\ffprobe.exe",
            version: "2026-08-03-git-01a25f74cc-full_build",
            available: true,
            error: null,
          },
          complete: true,
          warnings: [],
          checkedAt: now(),
        };
        return status as unknown as T;
      }
      case "open_path":
      case "open_url":
      case "reveal_path":
      case "open_folder":
      case "delete_file":
      case "focus_window":
      case "confirm_exit":
      case "apply_window_appearance":
        return undefined as unknown as T;
      case "path_facts":
        return {
          exists: true,
          isFile: false,
          isDir: true,
          sizeBytes: 0,
          modifiedAt: now(),
          writable: true,
        } as unknown as T;
      case "app_info": {
        const info: AppInfo = {
          name: "YT Downloader",
          version: "1.0.0",
          tauriVersion: "2.11.5",
          buildProfile: "browser-preview",
          target: "x86_64-windows",
          identifier: "com.ytdownloader.desktop",
        };
        return info as unknown as T;
      }
      default:
        throw new Error(`浏览器预览模式未实现命令：${command}`);
    }
  }
}

let backend: MockBackend | null = null;

/** Route one command to the preview backend. */
export function mockInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  backend ??= new MockBackend();
  return backend.invoke<T>(command, args);
}
