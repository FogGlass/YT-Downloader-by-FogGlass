/**
 * Settings.
 *
 * A preferences window rather than a long form: a vertical rail on the left, one
 * focused pane on the right. Every control maps to a real field of `AppSettings` that
 * the Rust backend reads — there are no decorative toggles here — and every edit is
 * written immediately as a whole section, so nothing depends on a "Save" button.
 *
 * Text fields keep keystrokes local and commit on blur; sliders commit when the drag
 * ends. That keeps one setting change to exactly one IPC call.
 */

import { motion, useReducedMotion } from "framer-motion";
import {
  ChevronRight,
  Cookie,
  Copy,
  Download,
  FileText,
  FolderOpen,
  Info,
  Monitor,
  Moon,
  Network,
  Palette,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Sun,
  Terminal,
  Trash2,
  Wrench,
  Youtube,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";

import { IpcError } from "@/api/client";
import { cookieStatus, validateCookieFile } from "@/api/cookies";
import * as runtimeApi from "@/api/runtime";
import { SettingRow } from "@/components/settings/SettingRow";
import { Button, IconButton } from "@/components/ui/Button";
import {
  SegmentedControl,
  Select,
  Slider,
  Switch,
  TextArea,
  TextInput,
  type SelectOption,
} from "@/components/ui/Controls";
import { EmptyState, ErrorState } from "@/components/ui/Feedback";
import { Tooltip } from "@/components/ui/Overlay";
import { Skeleton, Spinner } from "@/components/ui/Progress";
import { Badge, SectionHeader, StatusDot, Surface } from "@/components/ui/Surface";
import { cn } from "@/lib/cn";
import { pickDirectory, pickFile } from "@/lib/dialog";
import { formatBytes } from "@/lib/format";
import { spring } from "@/lib/motion";
import { useSettingsStore } from "@/stores/settings";
import { toast } from "@/stores/toasts";
import { PAGES, useUiStore } from "@/stores/ui";
import type {
  AdvancedSettings,
  AppSettings,
  AppearanceSettings,
  AudioCodecPreference,
  CodecPreference,
  CookieMode,
  CookieSettings,
  CookieStatus,
  CookieFileCheck,
  DownloadSettings,
  GeneralSettings,
  LogEntry,
  MergeContainer,
  MotionPreference,
  NetworkSettings,
  ProxyMode,
  SettingsPatch,
  ThemeMode,
  YoutubeSettings,
  YtDlpRuntimeMode,
} from "@/types/models";

/* -------------------------------------------------------------------------- */
/* Nav                                                                        */
/* -------------------------------------------------------------------------- */

type SettingsSection =
  | "general"
  | "downloads"
  | "youtube"
  | "cookies"
  | "network"
  | "appearance"
  | "advanced";

const SECTIONS: {
  id: SettingsSection;
  label: string;
  description: string;
  icon: LucideIcon;
}[] = [
  {
    id: "general",
    label: "通用",
    description: "启动行为、剪贴板与完成通知",
    icon: SlidersHorizontal,
  },
  {
    id: "downloads",
    label: "下载",
    description: "保存位置、命名规则与产物内容",
    icon: Download,
  },
  {
    id: "youtube",
    label: "YouTube",
    description: "编码偏好、清晰度与 JS 运行时",
    icon: Youtube,
  },
  {
    id: "cookies",
    label: "Cookies",
    description: "登录态来源；只读取本机数据",
    icon: Cookie,
  },
  { id: "network", label: "网络", description: "代理、限速、重试与超时", icon: Network },
  {
    id: "appearance",
    label: "外观",
    description: "主题、强调色、密度与动效",
    icon: Palette,
  },
  {
    id: "advanced",
    label: "高级",
    description: "运行库路径、原生命令行参数与诊断",
    icon: Wrench,
  },
];

/* -------------------------------------------------------------------------- */
/* Option tables                                                              */
/* -------------------------------------------------------------------------- */

/** `""` means "whatever yt-dlp picks"; Radix cannot carry an empty item value. */
const HEIGHT_OPTIONS: SelectOption[] = [
  { value: "best", label: "最佳", description: "不限制高度，选择最高画质" },
  { value: "2160", label: "2160p", description: "4K" },
  { value: "1440", label: "1440p", description: "2K" },
  { value: "1080", label: "1080p", description: "全高清" },
  { value: "720", label: "720p", description: "高清" },
  { value: "480", label: "480p", description: "标清" },
];

const JS_RUNTIME_OPTIONS: SelectOption[] = [
  { value: "auto", label: "自动", description: "由 yt-dlp 自行选择" },
  { value: "node", label: "Node.js", description: "--js-runtimes node" },
  { value: "deno", label: "Deno", description: "--js-runtimes deno" },
];

const TEMPLATE_PRESETS: { label: string; template: string }[] = [
  { label: "标题", template: "%(title)s.%(ext)s" },
  { label: "上传者目录", template: "%(uploader)s/%(title)s.%(ext)s" },
  { label: "播放列表序号", template: "%(playlist_index)02d - %(title)s.%(ext)s" },
];

const ACCENTS = ["violet", "azure", "emerald", "rose", "amber"] as const;
type AccentName = (typeof ACCENTS)[number];

const ACCENT_LABELS: Record<AccentName, string> = {
  violet: "紫罗兰",
  azure: "天蓝",
  emerald: "翡翠",
  rose: "玫瑰",
  amber: "琥珀",
};

const LOG_LEVEL_TONES: Record<LogEntry["level"], string> = {
  debug: "text-content-tertiary",
  info: "text-info",
  warn: "text-warning",
  error: "text-danger",
};

const BROWSER_OPTIONS: SelectOption[] = [
  { value: "chrome", label: "Chrome" },
  { value: "edge", label: "Edge" },
  { value: "firefox", label: "Firefox" },
  { value: "brave", label: "Brave" },
  { value: "opera", label: "Opera" },
  { value: "vivaldi", label: "Vivaldi" },
];

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

type SectionSaver<T> = (change: Partial<T>, quiet?: boolean) => void;

/** Radix hands back a plain string; the option lists above are exhaustive. */
const option = <T extends string>(value: string): T => value as T;

/**
 * Mirrors the backend's `is_on_c_drive`.
 *
 * The application warns — it never blocks and never rewrites — when a user points it
 * at the system drive, because that is a deliberate choice they are allowed to make.
 */
const isOnSystemDrive = (path: string): boolean => /^c:/i.test(path.trim());

const describeError = (error: unknown): string =>
  error instanceof IpcError ? error.message : String(error);

/* -------------------------------------------------------------------------- */
/* Draft controls                                                             */
/* -------------------------------------------------------------------------- */

interface DraftFieldProps {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  className?: string;
  spellCheck?: boolean;
  ariaLabel?: string;
}

/** Text input that writes to the backend once, when the field loses focus. */
function DraftField({
  value,
  onCommit,
  placeholder,
  className,
  spellCheck = false,
  ariaLabel,
}: DraftFieldProps) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
    }
  }, [value]);

  return (
    <TextInput
      className={className}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellCheck={spellCheck}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        const next = draft.trim();
        if (next !== value) {
          onCommit(next);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** Same contract as {@link DraftField}, for the multi-line argument fields. */
function DraftTextArea({
  value,
  onCommit,
  placeholder,
  rows = 3,
  ariaLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder?: string;
  rows?: number;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
    }
  }, [value]);

  return (
    <TextArea
      className="selectable font-mono text-caption"
      rows={rows}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        const next = draft.trim();
        if (next !== value) {
          onCommit(next);
        }
      }}
    />
  );
}

/**
 * Slider that reports one value per interaction.
 *
 * Radix fires `onValueChange` for every pixel of a drag, which would mean dozens of
 * settings writes for one gesture — so the drag stays local and only the release is
 * committed.
 */
function LocalSlider({
  value,
  min,
  max,
  step = 1,
  label,
  format,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  format?: (value: number) => string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const interacting = useRef(false);

  useEffect(() => {
    if (!interacting.current) {
      setDraft(value);
    }
  }, [value]);

  const commit = () => {
    interacting.current = false;
    if (draft !== value) {
      onCommit(draft);
    }
  };

  return (
    <div
      onPointerDown={() => {
        interacting.current = true;
      }}
      onKeyDown={() => {
        interacting.current = true;
      }}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
    >
      <Slider
        value={draft}
        min={min}
        max={max}
        step={step}
        label={label}
        format={format}
        onChange={setDraft}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                      */
/* -------------------------------------------------------------------------- */

/** A titled group of rows. Headers are small on purpose: the rows carry the weight. */
function SettingPanel({
  title,
  description,
  action,
  divided = true,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  divided?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="panel overflow-hidden">
      <header className="flex items-center justify-between gap-4 border-b border-line-subtle px-4 py-2.5">
        <div className="min-w-0">
          <h3 className="text-label font-semibold tracking-[-0.008em] text-content">
            {title}
          </h3>
          {description ? (
            <p className="mt-0.5 text-caption leading-[1.05rem] text-content-tertiary">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
      </header>
      <div className={cn(divided && "divide-y divide-[color:var(--border-subtle)]")}>
        {children}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export function SettingsPage() {
  const settings = useSettingsStore((state) => state.settings);
  const loading = useSettingsStore((state) => state.loading);
  const error = useSettingsStore((state) => state.error);
  const load = useSettingsStore((state) => state.load);

  if (loading && !settings) {
    return <SettingsSkeleton />;
  }

  if (!settings) {
    return (
      <div className="flex h-full items-start justify-center pt-10">
        <ErrorState
          title="无法加载设置"
          description={error ?? "后端没有返回设置数据。"}
          onRetry={() => void load()}
        />
      </div>
    );
  }

  return <SettingsBody settings={settings} />;
}

function SettingsBody({ settings }: { settings: AppSettings }) {
  const saving = useSettingsStore((state) => state.saving);
  const storage = useSettingsStore((state) => state.storage);
  const runtime = useSettingsStore((state) => state.runtime);
  const patch = useSettingsStore((state) => state.patch);
  const reduce = useReducedMotion();
  const [section, setSection] = useState<SettingsSection>("general");

  const active = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0];

  /** The whole section is always sent: the backend merges and persists it. */
  const commit = (next: SettingsPatch, quiet = true) => {
    void patch(next, { quiet });
  };

  const openOrPick = async (
    pick: () => Promise<string | null>,
  ): Promise<string | null> => {
    try {
      return await pick();
    } catch (caught) {
      toast.error("无法打开选择窗口", describeError(caught));
      return null;
    }
  };

  return (
    <div className="flex h-full min-h-0 gap-5">
      <aside className="panel flex w-[13.25rem] shrink-0 flex-col gap-0.5 self-start p-1.5">
        {SECTIONS.map((entry) => {
          const Icon = entry.icon;
          const selected = entry.id === section;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => setSection(entry.id)}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "group relative flex h-9 items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 text-left text-label font-medium transition-colors",
                selected ? "text-content" : "text-content-secondary hover:text-content",
              )}
            >
              {selected ? (
                <motion.span
                  layoutId="settings-rail"
                  transition={reduce ? { duration: 0 } : spring}
                  className="absolute inset-0 rounded-[var(--radius-md)] border border-line bg-surface-elevated"
                />
              ) : (
                <span className="absolute inset-0 rounded-[var(--radius-md)] opacity-0 transition-opacity group-hover:bg-surface-hover group-hover:opacity-100" />
              )}
              <span className="relative z-10 flex items-center gap-2.5">
                <Icon
                  className={cn(
                    "size-4 shrink-0 transition-colors",
                    selected
                      ? "text-accent"
                      : "text-content-tertiary group-hover:text-content-secondary",
                  )}
                  strokeWidth={selected ? 2.1 : 1.85}
                />
                <span className="truncate">{entry.label}</span>
              </span>
            </button>
          );
        })}

        <span className="my-1 h-px bg-line-subtle" aria-hidden />

        {/* 关于 lives on its own page: the rail only hands navigation over. */}
        <button
          type="button"
          onClick={() => useUiStore.getState().setPage("about")}
          className="group flex h-9 items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 text-left text-label font-medium text-content-secondary transition-colors hover:bg-surface-hover hover:text-content"
        >
          <Info
            className="size-4 shrink-0 text-content-tertiary transition-colors group-hover:text-content-secondary"
            strokeWidth={1.85}
          />
          <span className="flex-1 truncate">关于</span>
          <ChevronRight className="size-3.5 shrink-0 text-content-tertiary" />
        </button>
      </aside>

      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <SectionHeader
          title={active.label}
          description={active.description}
          action={
            saving ? (
              <span className="flex items-center gap-2 text-caption text-content-tertiary">
                <Spinner size={12} />
                正在保存…
              </span>
            ) : (
              <span className="text-caption text-content-tertiary">修改会立即生效</span>
            )
          }
        />

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="flex flex-col gap-4 pb-1">
            {section === "general" ? (
              <GeneralSection
                settings={settings.general}
                save={(change, quiet) =>
                  commit({ general: { ...settings.general, ...change } }, quiet)
                }
              />
            ) : null}

            {section === "downloads" ? (
              <DownloadsSection
                settings={settings.downloads}
                fallbackDir={storage?.downloadDir ?? ""}
                save={(change, quiet) =>
                  commit({ downloads: { ...settings.downloads, ...change } }, quiet)
                }
                pickFolder={() => openOrPick(() => pickDirectory("选择下载目录"))}
              />
            ) : null}

            {section === "youtube" ? (
              <YoutubeSection
                settings={settings.youtube}
                save={(change, quiet) =>
                  commit({ youtube: { ...settings.youtube, ...change } }, quiet)
                }
              />
            ) : null}

            {section === "cookies" ? (
              <CookiesSection
                settings={settings.cookies}
                save={(change, quiet) =>
                  commit({ cookies: { ...settings.cookies, ...change } }, quiet)
                }
                pickCookieFile={() =>
                  openOrPick(() =>
                    pickFile("选择 cookies.txt", [
                      { name: "Cookies 文本文件", extensions: ["txt"] },
                      { name: "所有文件", extensions: ["*"] },
                    ]),
                  )
                }
              />
            ) : null}

            {section === "network" ? (
              <NetworkSection
                settings={settings.network}
                save={(change, quiet) =>
                  commit({ network: { ...settings.network, ...change } }, quiet)
                }
              />
            ) : null}

            {section === "appearance" ? (
              <AppearanceSection
                settings={settings.appearance}
                save={(change, quiet) =>
                  commit({ appearance: { ...settings.appearance, ...change } }, quiet)
                }
              />
            ) : null}

            {section === "advanced" ? (
              <AdvancedSection
                settings={settings.advanced}
                binDir={runtime?.binDir ?? ""}
                save={(change, quiet) =>
                  commit({ advanced: { ...settings.advanced, ...change } }, quiet)
                }
                pickFolder={() => openOrPick(() => pickDirectory("选择运行库目录"))}
                pickPython={() =>
                  openOrPick(() =>
                    pickFile("选择 Python 可执行文件", [
                      { name: "可执行文件", extensions: ["exe"] },
                      { name: "所有文件", extensions: ["*"] },
                    ]),
                  )
                }
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 通用                                                                        */
/* -------------------------------------------------------------------------- */

function GeneralSection({
  settings,
  save,
}: {
  settings: GeneralSettings;
  save: SectionSaver<GeneralSettings>;
}) {
  const lastPageLabel =
    PAGES.find((page) => page.id === settings.lastPage)?.label ?? settings.lastPage;

  return (
    <SettingPanel
      title="启动与通知"
      description="这些开关只影响本机界面行为，不会改变 yt-dlp 的参数。"
    >
      <SettingRow
        title="退出前确认"
        description="仍有下载任务时，关闭窗口会先弹出确认提示。"
      >
        <Switch
          label="退出前确认"
          checked={settings.confirmBeforeExit}
          onCheckedChange={(checked) => save({ confirmBeforeExit: checked })}
        />
      </SettingRow>

      <SettingRow
        title="监视剪贴板"
        description="复制视频链接后自动填入新建下载页的输入框，仍需手动解析。"
      >
        <Switch
          label="监视剪贴板"
          checked={settings.watchClipboard}
          onCheckedChange={(checked) => save({ watchClipboard: checked })}
        />
      </SettingRow>

      <SettingRow
        title="完成后通知"
        description="每个任务下载完成时显示一条可打开文件的提示。"
      >
        <Switch
          label="完成后通知"
          checked={settings.notifyOnComplete}
          onCheckedChange={(checked) => save({ notifyOnComplete: checked })}
        />
      </SettingRow>

      <SettingRow
        title="记住上次页面"
        description="下次启动时回到退出前所在的页面。"
        value={`当前记录：${lastPageLabel}`}
      >
        <Switch
          label="记住上次页面"
          checked={settings.restoreLastPage}
          onCheckedChange={(checked) => save({ restoreLastPage: checked })}
        />
      </SettingRow>
    </SettingPanel>
  );
}

/* -------------------------------------------------------------------------- */
/* 下载                                                                        */
/* -------------------------------------------------------------------------- */

function DownloadsSection({
  settings,
  save,
  fallbackDir,
  pickFolder,
}: {
  settings: DownloadSettings;
  save: SectionSaver<DownloadSettings>;
  fallbackDir: string;
  pickFolder: () => Promise<string | null>;
}) {
  const effectiveDir = settings.outputDir.trim() || fallbackDir;
  const onSystemDrive = isOnSystemDrive(effectiveDir);
  const subtitleLanguages = settings.subtitleLanguages.trim();

  const openDirectory = async () => {
    if (!effectiveDir) {
      toast.error("还没有可打开的目录", "请先选择一个下载目录。");
      return;
    }
    try {
      await runtimeApi.openFolder(effectiveDir);
    } catch (error) {
      toast.error("无法打开目录", describeError(error));
    }
  };

  return (
    <>
      <SettingPanel
        title="保存位置"
        description="默认写到程序自身的 downloads 目录，不会静默写入系统盘。"
        action={
          <Button
            size="xs"
            variant="ghost"
            icon={<FolderOpen className="size-3.5" />}
            onClick={() => void openDirectory()}
          >
            打开目录
          </Button>
        }
      >
        <SettingRow
          layout="stacked"
          title="下载目录"
          description="下载完成的文件、封面与字幕都写到这里；留空时使用程序自带目录。"
          value={effectiveDir ? <span className="font-mono">当前生效：{effectiveDir}</span> : null}
          warning={
            onSystemDrive
              ? "该目录位于系统盘（C:）。程序不会替你改动，但建议选择其他分区。"
              : null
          }
        >
          <div className="flex items-center gap-2">
            <DraftField
              className="min-w-0 flex-1"
              value={settings.outputDir}
              placeholder={fallbackDir || "留空表示使用程序自带目录"}
              ariaLabel="下载目录"
              onCommit={(next) => save({ outputDir: next }, false)}
            />
            <Button
              size="sm"
              variant="secondary"
              icon={<FolderOpen className="size-3.5" />}
              onClick={async () => {
                const picked = await pickFolder();
                if (picked) {
                  save({ outputDir: picked }, false);
                }
              }}
            >
              选择文件夹
            </Button>
          </div>
        </SettingRow>

        <SettingRow
          title="播放列表子目录"
          description="把整个播放列表或频道下载到以它命名的子目录中。"
        >
          <Switch
            label="播放列表子目录"
            checked={settings.playlistSubfolder}
            onCheckedChange={(checked) => save({ playlistSubfolder: checked })}
          />
        </SettingRow>

        <SettingRow
          title="同时下载数"
          description="并行运行的任务数量；数值越高占用带宽越多。"
        >
          <LocalSlider
            label="同时下载数"
            value={settings.concurrency}
            min={1}
            max={8}
            onCommit={(next) => save({ concurrency: next })}
          />
        </SettingRow>
      </SettingPanel>

      <SettingPanel
        title="文件命名"
        description="使用 yt-dlp 的模板语法，可用 %(title)s、%(uploader)s、%(playlist_index)s 等字段。"
      >
        <SettingRow
          layout="stacked"
          title="文件名模板"
          description="决定输出文件与目录的相对路径。"
          value={
            <span className="font-mono text-content-tertiary">
              {settings.filenameTemplate || "%(title)s.%(ext)s"}
            </span>
          }
        >
          <DraftField
            value={settings.filenameTemplate}
            placeholder="%(title)s.%(ext)s"
            ariaLabel="文件名模板"
            onCommit={(next) => save({ filenameTemplate: next })}
          />
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {TEMPLATE_PRESETS.map((preset) => (
              <Tooltip
                key={preset.template}
                label={<span className="font-mono">{preset.template}</span>}
              >
                <Button
                  size="xs"
                  variant={
                    settings.filenameTemplate === preset.template ? "subtle" : "ghost"
                  }
                  onClick={() => save({ filenameTemplate: preset.template })}
                >
                  {preset.label}
                </Button>
              </Tooltip>
            ))}
          </div>
        </SettingRow>

        <SettingRow
          layout="stacked"
          title="合并容器"
          description="分离的音视频流合并成什么格式；自动会按编码选择可直接播放的组合。"
        >
          <Select
            ariaLabel="合并容器"
            className="w-full"
            value={settings.mergeContainer}
            options={[
              { value: "auto", label: "自动", description: "WebM/Opus → webm，MP4/M4A → mp4，其余 → mkv" },
              { value: "matroska", label: "Matroska (MKV)", description: "兼容性最好，可容纳任意编码组合" },
              { value: "mp4", label: "MP4", description: "通用性最好，但部分编码无法放入" },
              { value: "webm", label: "WebM", description: "仅适合 VP9/AV1 + Opus" },
            ]}
            onChange={(value) => save({ mergeContainer: option<MergeContainer>(value) })}
          />
        </SettingRow>

        <SettingRow
          title="保留分离的流"
          description="合并完成后保留原始的视频与音频文件，便于二次处理。"
        >
          <Switch
            label="保留分离的流"
            checked={settings.keepStreams}
            onCheckedChange={(checked) => save({ keepStreams: checked })}
          />
        </SettingRow>
      </SettingPanel>

      <SettingPanel
        title="封面、字幕与元数据"
        description="这些开关直接对应 yt-dlp 的写入与嵌入参数。"
      >
        <SettingRow
          title="保存封面文件"
          description="额外保存一张 jpg 封面，不嵌入视频。"
        >
          <Switch
            label="保存封面文件"
            checked={settings.writeThumbnail}
            onCheckedChange={(checked) => save({ writeThumbnail: checked })}
          />
        </SettingRow>

        <SettingRow title="嵌入封面" description="把封面写进最终文件。">
          <Switch
            label="嵌入封面"
            checked={settings.embedThumbnail}
            onCheckedChange={(checked) => save({ embedThumbnail: checked })}
          />
        </SettingRow>

        <SettingRow
          title="嵌入元数据"
          description="写入标题、上传者、日期与简介等信息。"
        >
          <Switch
            label="嵌入元数据"
            checked={settings.embedMetadata}
            onCheckedChange={(checked) => save({ embedMetadata: checked })}
          />
        </SettingRow>

        <SettingRow
          title="嵌入章节"
          description="把视频章节写入文件，播放器可直接跳转。"
        >
          <Switch
            label="嵌入章节"
            checked={settings.embedChapters}
            onCheckedChange={(checked) => save({ embedChapters: checked })}
          />
        </SettingRow>

        <SettingRow
          title="下载字幕"
          description="下载所选语言的人工字幕，并转换为 srt 后嵌入。"
        >
          <Switch
            label="下载字幕"
            checked={settings.writeSubtitles}
            onCheckedChange={(checked) => save({ writeSubtitles: checked })}
          />
        </SettingRow>

        <SettingRow
          layout="stacked"
          title="字幕语言"
          description="逗号分隔的语言代码；可写 all 表示全部可用语言。"
          value={
            subtitleLanguages ? (
              <span className="font-mono">{subtitleLanguages}</span>
            ) : (
              "已留空：使用 yt-dlp 的默认语言"
            )
          }
        >
          <DraftField
            value={settings.subtitleLanguages}
            placeholder="zh-Hans,zh-Hant,en"
            ariaLabel="字幕语言"
            onCommit={(next) => save({ subtitleLanguages: next })}
          />
        </SettingRow>

        <SettingRow
          title="自动生成字幕"
          description="同时下载平台自动识别的字幕，准确度取决于平台。"
        >
          <Switch
            label="自动生成字幕"
            checked={settings.writeAutoSubtitles}
            onCheckedChange={(checked) => save({ writeAutoSubtitles: checked })}
          />
        </SettingRow>

        <SettingRow title="保存简介" description="把视频简介另存为一个文本文件。">
          <Switch
            label="保存简介"
            checked={settings.writeDescription}
            onCheckedChange={(checked) => save({ writeDescription: checked })}
          />
        </SettingRow>
      </SettingPanel>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* YouTube                                                                    */
/* -------------------------------------------------------------------------- */

function YoutubeSection({
  settings,
  save,
}: {
  settings: YoutubeSettings;
  save: SectionSaver<YoutubeSettings>;
}) {
  return (
    <>
      <SettingPanel
        title="格式偏好"
        description="自动选择格式时按这些偏好排序，手动挑选格式时不受影响。"
      >
        <SettingRow
          layout="stacked"
          title="视频编码"
          description="同等画质下优先选择的编码；AV1 体积最小，H.264 兼容性最好。"
        >
          <Select
            ariaLabel="视频编码偏好"
            className="w-full"
            value={settings.videoCodecPreference}
            options={[
              { value: "auto", label: "自动", description: "由 yt-dlp 决定" },
              { value: "av1", label: "AV1", description: "体积最小，老设备可能无法硬解" },
              { value: "vp9", label: "VP9", description: "WebM 常用，兼容性较好" },
              { value: "h264", label: "H.264", description: "兼容性最好，码率略高" },
            ]}
            onChange={(value) =>
              save({ videoCodecPreference: option<CodecPreference>(value) })
            }
          />
        </SettingRow>

        <SettingRow
          layout="stacked"
          title="音频编码"
          description="Opus 适合 WebM，AAC 适合 MP4；自动会跟随视频容器。"
        >
          <Select
            ariaLabel="音频编码偏好"
            className="w-full"
            value={settings.audioCodecPreference}
            options={[
              { value: "auto", label: "自动", description: "由 yt-dlp 决定" },
              { value: "opus", label: "Opus", description: "同码率下音质更好" },
              { value: "aac", label: "AAC", description: "设备兼容性更好" },
            ]}
            onChange={(value) =>
              save({ audioCodecPreference: option<AudioCodecPreference>(value) })
            }
          />
        </SettingRow>

        <SettingRow
          layout="stacked"
          title="最大分辨率"
          description="限制自动选择时的最高高度，不会改变手动选择的格式。"
        >
          {/* Radix cannot carry an empty option value, so "" travels as "best". */}
          <Select
            ariaLabel="最大分辨率"
            className="w-full"
            value={settings.maxHeight || "best"}
            options={HEIGHT_OPTIONS}
            onChange={(value) => save({ maxHeight: value === "best" ? "" : value })}
          />
        </SettingRow>

        <SettingRow
          title="优先 HDR"
          description="在相同分辨率下优先选择 HDR / 高动态范围格式。"
        >
          <Switch
            label="优先 HDR"
            checked={settings.preferHdr}
            onCheckedChange={(checked) => save({ preferHdr: checked })}
          />
        </SettingRow>

        <SettingRow
          title="优先 60fps"
          description="在相同分辨率下优先选择高帧率格式，文件会更大。"
        >
          <Switch
            label="优先 60fps"
            checked={settings.prefer60fps}
            onCheckedChange={(checked) => save({ prefer60fps: checked })}
          />
        </SettingRow>
      </SettingPanel>

      <SettingPanel
        title="兼容性"
        description="YouTube 的签名解密与接口变化需要这些额外参数。"
      >
        <SettingRow
          layout="stacked"
          title="JS 运行时"
          description="yt-dlp 用于解密签名的 JavaScript 运行时；留空表示由 yt-dlp 自行探测。"
        >
          <Select
            ariaLabel="JS 运行时"
            className="w-full"
            value={settings.jsRuntime || "auto"}
            options={JS_RUNTIME_OPTIONS}
            onChange={(value) => save({ jsRuntime: value === "auto" ? "" : value })}
          />
        </SettingRow>

        <SettingRow
          layout="stacked"
          title="extractor 参数"
          description="直接传给 --extractor-args，例如 youtube:player_client=web_safari。"
        >
          <DraftField
            value={settings.extractorArgs}
            placeholder="youtube:player_client=web_safari"
            ariaLabel="extractor 参数"
            onCommit={(next) => save({ extractorArgs: next })}
          />
        </SettingRow>
      </SettingPanel>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Cookies                                                                    */
/* -------------------------------------------------------------------------- */

function CookiesSection({
  settings,
  save,
  pickCookieFile,
}: {
  settings: CookieSettings;
  save: SectionSaver<CookieSettings>;
  pickCookieFile: () => Promise<string | null>;
}) {
  return (
    <SettingPanel
      title="登录态来源"
      description="Cookies 只在本机由 yt-dlp 读取，用于需要登录才能访问的内容；不会上传，也不会写入日志。这里只会显示文件路径，从不显示 Cookie 内容。"
    >
      <SettingRow
        layout="stacked"
        title="使用方式"
        description="选择不使用、从浏览器读取，或指定一个 cookies.txt 文件。"
      >
        <SegmentedControl<CookieMode>
          layoutId="settings-cookie-mode"
          value={settings.mode}
          segments={[
            { value: "none", label: "不使用" },
            { value: "browser", label: "浏览器" },
            { value: "file", label: "文件" },
          ]}
          onChange={(value) => save({ mode: value })}
        />
      </SettingRow>

      {settings.mode === "browser" ? (
        <>
          <SettingRow
            layout="stacked"
            title="浏览器"
            description="读取本机该浏览器已保存的登录态；浏览器需处于关闭状态才能稳定读取。"
          >
            <Select
              ariaLabel="浏览器"
              className="w-full"
              value={settings.browser}
              options={BROWSER_OPTIONS}
              onChange={(value) => save({ browser: value })}
            />
          </SettingRow>

          <SettingRow
            layout="stacked"
            title="浏览器配置目录"
            description="多用户配置时可指定名称；留空表示使用默认配置。"
            value={
              settings.profile.trim() ? (
                <span className="font-mono">{settings.profile.trim()}</span>
              ) : (
                "已留空：使用默认配置文件"
              )
            }
          >
            <DraftField
              value={settings.profile}
              placeholder="Default 或 Profile 1"
              ariaLabel="浏览器配置目录"
              onCommit={(next) => save({ profile: next })}
            />
          </SettingRow>
        </>
      ) : null}

      {settings.mode === "file" ? (
        <SettingRow
          layout="stacked"
          title="cookies.txt 文件"
          description="只保存路径；文件由 yt-dlp 直接读取，应用不会解析或显示其中的内容。"
          value={
            settings.file.trim() ? (
              <span className="font-mono">已配置：{settings.file.trim()}</span>
            ) : (
              "尚未选择文件，当前等同于不使用 Cookies"
            )
          }
        >
          <div className="flex items-center gap-2">
            <DraftField
              className="min-w-0 flex-1"
              value={settings.file}
              placeholder="E:\\path\\to\\cookies.txt"
              ariaLabel="cookies 文件路径"
              onCommit={(next) => save({ file: next }, false)}
            />
            <Button
              size="sm"
              variant="secondary"
              icon={<FileText className="size-3.5" />}
              onClick={async () => {
                const picked = await pickCookieFile();
                if (picked) {
                  save({ file: picked }, false);
                }
              }}
            >
              选择 cookies.txt
            </Button>
          </div>
        </SettingRow>
      ) : null}

      <CookieDiagnostics settings={settings} onUseBrowser={(key) => save({ mode: "browser", browser: key })} />
    </SettingPanel>
  );
}

/**
 * Live state of the configured cookie source.
 *
 * A browser cookie store fails for reasons that are not "you are logged out": the
 * browser may be running and holding the database open, or it may protect cookie values
 * with app-bound encryption (Edge 127+), which no third-party tool can decrypt. The
 * panel reports exactly which one it is, and never shows a cookie value.
 */
function CookieDiagnostics({
  settings,
  onUseBrowser,
}: {
  settings: CookieSettings;
  onUseBrowser: (browser: string) => void;
}) {
  const [status, setStatus] = useState<CookieStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [fileCheck, setFileCheck] = useState<CookieFileCheck | null>(null);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await cookieStatus());
    } catch {
      setStatus(null);
    } finally {
      setChecking(false);
    }
  }, []);

  // Re-inspect whenever the configuration changes.
  useEffect(() => {
    void refresh();
  }, [refresh, settings.mode, settings.browser, settings.profile]);

  useEffect(() => {
    if (settings.mode !== "file" || !settings.file.trim()) {
      setFileCheck(null);
      return;
    }
    let cancelled = false;
    void validateCookieFile(settings.file.trim())
      .then((result) => {
        if (!cancelled) {
          setFileCheck(result);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [settings.mode, settings.file]);

  if (settings.mode === "none") {
    return null;
  }

  const installed = (status?.installedBrowsers ?? []).filter((browser) => browser.installed);
  const problematic =
    settings.mode === "browser" &&
    status !== null &&
    (!status.databaseExists || status.locked || status.appBoundEncryption);
  const fileProblem = settings.mode === "file" && fileCheck !== null && !fileCheck.exists;

  return (
    <div className="flex flex-col gap-2.5 border-t border-line-subtle px-4 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-micro tracking-[0.08em] text-content-tertiary uppercase">
          读取状态
        </span>
        <Button
          size="xs"
          variant="ghost"
          loading={checking}
          icon={<RefreshCw className="size-3" />}
          onClick={() => void refresh()}
        >
          重新检测
        </Button>
      </div>

      {settings.mode === "browser" && status ? (
        <>
          <div
            className={cn(
              "flex items-start gap-2 rounded-[var(--radius-sm)] border px-3 py-2 text-caption",
              problematic
                ? "border-warning/30 bg-warning-soft text-warning"
                : "border-line bg-surface-muted text-content-secondary",
            )}
          >
            <StatusDot tone={problematic ? "warning" : "success"} className="mt-1.5 shrink-0" />
            <span className="flex-1">
              <span className="block">{status.message}</span>
              {status.hint ? (
                <span className="mt-0.5 block opacity-90">{status.hint}</span>
              ) : null}
            </span>
          </div>

          {installed.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-micro text-content-tertiary">已检测到：</span>
              {installed.map((browser) => (
                <button
                  key={browser.key}
                  type="button"
                  onClick={() => onUseBrowser(browser.key)}
                  className={cn(
                    "rounded-full border px-2 py-[3px] text-micro transition-colors",
                    browser.key === status.browserKey
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-line text-content-tertiary hover:text-content-secondary",
                  )}
                >
                  {browser.name}
                  {browser.appBoundEncryption ? " · 应用绑定加密" : ""}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-micro text-content-tertiary">
              未检测到已安装的浏览器；也可以改用 cookies.txt。
            </p>
          )}

          {status.databasePath ? (
            <p
              className="truncate font-mono text-micro text-content-tertiary"
              title={status.databasePath}
            >
              {status.databasePath}
            </p>
          ) : null}
        </>
      ) : null}

      {settings.mode === "file" && fileCheck ? (
        <div
          className={cn(
            "flex items-start gap-2 rounded-[var(--radius-sm)] border px-3 py-2 text-caption",
            fileProblem || !fileCheck.looksLikeCookiejar
              ? "border-warning/30 bg-warning-soft text-warning"
              : "border-line bg-surface-muted text-content-secondary",
          )}
        >
          <FileText className="mt-0.5 size-3.5 shrink-0" />
          <span className="flex-1">{fileCheck.message}</span>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 网络                                                                        */
/* -------------------------------------------------------------------------- */

function NetworkSection({
  settings,
  save,
}: {
  settings: NetworkSettings;
  save: SectionSaver<NetworkSettings>;
}) {
  return (
    <>
      <SettingPanel
        title="代理"
        description="代理只影响 yt-dlp 的请求，不会修改系统网络设置。"
      >
        <SettingRow
          layout="stacked"
          title="代理模式"
          description="系统模式读取 Windows 的 WinINET 代理；手动模式使用下面的地址。"
        >
          <SegmentedControl<ProxyMode>
            layoutId="settings-proxy-mode"
            value={settings.proxyMode}
            segments={[
              { value: "none", label: "不使用" },
              { value: "system", label: "系统代理" },
              { value: "manual", label: "手动" },
            ]}
            onChange={(value) => save({ proxyMode: value })}
          />
        </SettingRow>

        {settings.proxyMode === "manual" ? (
          <SettingRow
            layout="stacked"
            title="代理地址"
            description="支持 http、https 与 socks5 协议，留空表示不添加代理参数。"
          >
            <DraftField
              value={settings.proxyUrl}
              placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
              ariaLabel="代理地址"
              onCommit={(next) => save({ proxyUrl: next })}
            />
          </SettingRow>
        ) : null}
      </SettingPanel>

      <SettingPanel
        title="传输"
        description="这些参数直接对应 yt-dlp 的重试、分片与超时选项。"
      >
        <SettingRow
          title="限速"
          description="单任务下载速度上限；0 表示不限制。"
        >
          <LocalSlider
            label="限速"
            value={settings.rateLimitKib}
            min={0}
            max={51200}
            step={256}
            format={(value) => (value === 0 ? "不限速" : `${value} KB/s`)}
            onCommit={(next) => save({ rateLimitKib: next })}
          />
        </SettingRow>

        <SettingRow
          title="重试次数"
          description="整段下载失败后的重试次数；0 表示不重试。"
        >
          <LocalSlider
            label="重试次数"
            value={settings.retries}
            min={0}
            max={30}
            onCommit={(next) => save({ retries: next })}
          />
        </SettingRow>

        <SettingRow
          title="分片重试次数"
          description="单个分片失败后的重试次数；0 表示不重试。"
        >
          <LocalSlider
            label="分片重试次数"
            value={settings.fragmentRetries}
            min={0}
            max={30}
            onCommit={(next) => save({ fragmentRetries: next })}
          />
        </SettingRow>

        <SettingRow
          title="并发分片数"
          description="同时下载的分片数量，数值越高对服务器压力越大。"
        >
          <LocalSlider
            label="并发分片数"
            value={settings.concurrentFragments}
            min={1}
            max={16}
            onCommit={(next) => save({ concurrentFragments: next })}
          />
        </SettingRow>

        <SettingRow
          title="连接超时"
          description="单次 socket 读取的等待上限，网络较慢时可调高。"
        >
          <LocalSlider
            label="连接超时"
            value={settings.socketTimeoutSeconds}
            min={5}
            max={120}
            format={(value) => `${value} 秒`}
            onCommit={(next) => save({ socketTimeoutSeconds: next })}
          />
        </SettingRow>
      </SettingPanel>

      <SettingPanel title="连接" description="仅在网络环境受限时调整。">
        <SettingRow
          title="强制使用 IPv4"
          description="只通过 IPv4 连接，适合 IPv6 路由异常的网络。"
        >
          <Switch
            label="强制使用 IPv4"
            checked={settings.forceIpv4}
            onCheckedChange={(checked) => save({ forceIpv4: checked })}
          />
        </SettingRow>

        <SettingRow
          title="跳过证书校验"
          description="关闭 TLS 证书校验，会失去对中间人攻击的防护。"
          warning="开启后无法确认连接对象的身份，请仅在自建代理或抓包调试时使用。"
        >
          <Switch
            label="跳过证书校验"
            checked={settings.noCheckCertificates}
            onCheckedChange={(checked) => save({ noCheckCertificates: checked })}
          />
        </SettingRow>
      </SettingPanel>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* 外观                                                                        */
/* -------------------------------------------------------------------------- */

function AppearanceSection({
  settings,
  save,
}: {
  settings: AppearanceSettings;
  save: SectionSaver<AppearanceSettings>;
}) {
  const accent = (ACCENTS as readonly string[]).includes(settings.accent)
    ? (settings.accent as AccentName)
    : "violet";

  return (
    <>
      <SettingPanel
        title="主题与强调色"
        description="主题与强调色会立即应用到整个界面。"
      >
        <SettingRow
          layout="stacked"
          title="主题"
          description="跟随系统会随 Windows 的浅色/深色设置自动切换。"
        >
          <SegmentedControl<ThemeMode>
            layoutId="settings-theme"
            value={settings.theme}
            segments={[
              { value: "dark", label: "深色", icon: <Moon className="size-3.5" /> },
              { value: "light", label: "浅色", icon: <Sun className="size-3.5" /> },
              { value: "system", label: "跟随系统", icon: <Monitor className="size-3.5" /> },
            ]}
            onChange={(value) => save({ theme: value })}
          />
        </SettingRow>

        <SettingRow
          layout="stacked"
          title="强调色"
          description="用于按钮、选中态与进度条的主色。"
          value={`当前：${ACCENT_LABELS[accent]}`}
        >
          {/* Each swatch scopes `data-accent` to itself, so the dot shows the real
              resolved accent for the active theme instead of a hard-coded colour. */}
          <div className="flex items-center gap-2">
            {ACCENTS.map((name) => {
              const selected = name === accent;
              return (
                <button
                  key={name}
                  type="button"
                  data-accent={name}
                  aria-label={`强调色：${ACCENT_LABELS[name]}`}
                  aria-pressed={selected}
                  onClick={() => save({ accent: name })}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full border transition-colors",
                    selected
                      ? "border-accent ring-2 ring-accent/40"
                      : "border-line hover:border-line-strong",
                  )}
                >
                  <span className="size-4 rounded-full bg-accent" />
                </button>
              );
            })}
          </div>
        </SettingRow>
      </SettingPanel>

      <SettingPanel title="界面" description="密度与动效设置会影响所有页面。">
        <SettingRow
          title="紧凑密度"
          description="缩小正文与行高，在同样的窗口里显示更多内容。"
        >
          <Switch
            label="紧凑密度"
            checked={settings.compact}
            onCheckedChange={(checked) => save({ compact: checked })}
          />
        </SettingRow>

        <SettingRow
          layout="stacked"
          title="动效"
          description="跟随系统会尊重 Windows 的“减少动画”设置。"
        >
          <SegmentedControl<MotionPreference>
            layoutId="settings-motion"
            value={settings.motion}
            segments={[
              { value: "system", label: "跟随系统" },
              { value: "full", label: "完整" },
              { value: "reduced", label: "减少" },
            ]}
            onChange={(value) => save({ motion: value })}
          />
        </SettingRow>

        <SettingRow
          title="环境光背景"
          description="页面底部的两团缓慢渐变；关闭后界面更干净，也更省电。"
        >
          <Switch
            label="环境光背景"
            checked={settings.ambientBackground}
            onCheckedChange={(checked) => save({ ambientBackground: checked })}
          />
        </SettingRow>

        <SettingRow
          title="显示侧边栏文字"
          description="关闭后侧边栏只保留图标，折叠时同样隐藏文字。"
        >
          <Switch
            label="显示侧边栏文字"
            checked={settings.showSidebarLabels}
            onCheckedChange={(checked) => save({ showSidebarLabels: checked })}
          />
        </SettingRow>
      </SettingPanel>

      <SettingPanel title="窗口" description="与操作系统窗口装饰相关的设置。">
        <SettingRow
          title="使用系统标题栏"
          description="关闭时使用应用自绘标题栏。"
          warning="切换后窗口装饰会立即重建，标题栏布局随之重新加载。"
        >
          <Switch
            label="使用系统标题栏"
            checked={settings.nativeDecorations}
            onCheckedChange={(checked) => save({ nativeDecorations: checked })}
          />
        </SettingRow>
      </SettingPanel>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* 高级                                                                        */
/* -------------------------------------------------------------------------- */

function AdvancedSection({
  settings,
  save,
  binDir,
  pickFolder,
  pickPython,
}: {
  settings: AdvancedSettings;
  save: SectionSaver<AdvancedSettings>;
  binDir: string;
  pickFolder: () => Promise<string | null>;
  pickPython: () => Promise<string | null>;
}) {
  const [checking, setChecking] = useState(false);
  const usesPython = settings.ytdlpMode !== "executable";
  const onSystemDrive = isOnSystemDrive(settings.toolsDir.trim() || binDir);

  const checkRuntime = async () => {
    setChecking(true);
    try {
      await useSettingsStore.getState().refreshRuntime();
      toast.success("运行库状态已更新");
    } finally {
      setChecking(false);
    }
  };

  const confirmReset = () => {
    useUiStore.getState().openConfirm({
      title: "恢复默认设置？",
      description:
        "下载目录、网络、外观与高级选项都会回到初始值，下载目录会回到程序所在分区的默认位置。此操作无法撤销。",
      confirmLabel: "恢复默认",
      danger: true,
      onConfirm: () => useSettingsStore.getState().reset(),
    });
  };

  return (
    <>
      <SettingPanel
        title="运行库"
        description="yt-dlp、FFmpeg 与 FFprobe 的查找位置。修改后可立即重新检测。"
        action={
          <Button
            size="xs"
            variant="ghost"
            icon={<RefreshCw className="size-3.5" />}
            loading={checking}
            onClick={() => void checkRuntime()}
          >
            重新检测
          </Button>
        }
      >
        <SettingRow
          layout="stacked"
          title="运行库目录"
          description="留空时按内置顺序自动查找可执行文件。"
          value={
            binDir ? <span className="font-mono">当前解析：{binDir}</span> : "尚未解析出目录"
          }
          warning={
            onSystemDrive ? "当前运行库位于系统盘（C:），建议放到其他分区。" : null
          }
        >
          <div className="flex items-center gap-2">
            <DraftField
              className="min-w-0 flex-1"
              value={settings.toolsDir}
              placeholder={binDir || "留空表示自动查找"}
              ariaLabel="运行库目录"
              onCommit={(next) => save({ toolsDir: next }, false)}
            />
            <Button
              size="sm"
              variant="secondary"
              icon={<FolderOpen className="size-3.5" />}
              onClick={async () => {
                const picked = await pickFolder();
                if (picked) {
                  save({ toolsDir: picked }, false);
                }
              }}
            >
              选择运行库目录
            </Button>
          </div>
        </SettingRow>

        <SettingRow
          layout="stacked"
          title="yt-dlp 运行方式"
          description="自动会优先使用可执行文件，失败时回退到 Python 模块。"
        >
          <Select
            ariaLabel="yt-dlp 运行方式"
            className="w-full"
            value={settings.ytdlpMode}
            options={[
              { value: "auto", label: "自动", description: "可执行文件优先，必要时回退到 Python 模块" },
              { value: "executable", label: "可执行文件", description: "使用 yt-dlp.exe" },
              { value: "pythonModule", label: "Python 模块", description: "使用 python -m yt_dlp" },
            ]}
            onChange={(value) => save({ ytdlpMode: option<YtDlpRuntimeMode>(value) })}
          />
        </SettingRow>

        {usesPython ? (
          <>
            <SettingRow
              layout="stacked"
              title="Python 路径"
              description="留空时使用系统 PATH 中的 python。"
            >
              <div className="flex items-center gap-2">
                <DraftField
                  className="min-w-0 flex-1"
                  value={settings.pythonPath}
                  placeholder="E:\\Python\\python.exe"
                  ariaLabel="Python 路径"
                  onCommit={(next) => save({ pythonPath: next }, false)}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<FileText className="size-3.5" />}
                  onClick={async () => {
                    const picked = await pickPython();
                    if (picked) {
                      save({ pythonPath: picked }, false);
                    }
                  }}
                >
                  选择 Python
                </Button>
              </div>
            </SettingRow>

            <SettingRow
              layout="stacked"
              title="yt_dlp 模块目录"
              description="包含 yt_dlp 包的目录，会被加入 PYTHONPATH；留空表示使用已安装的版本。"
            >
              <div className="flex items-center gap-2">
                <DraftField
                  className="min-w-0 flex-1"
                  value={settings.pythonModuleDir}
                  placeholder="E:\\src\\yt-dlp"
                  ariaLabel="yt_dlp 模块目录"
                  onCommit={(next) => save({ pythonModuleDir: next }, false)}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<FolderOpen className="size-3.5" />}
                  onClick={async () => {
                    const picked = await pickFolder();
                    if (picked) {
                      save({ pythonModuleDir: picked }, false);
                    }
                  }}
                >
                  选择目录
                </Button>
              </div>
            </SettingRow>
          </>
        ) : null}
      </SettingPanel>

      <SettingPanel
        title="原生命令行参数"
        description="按空格分隔并支持引号，会分别追加到每一次 yt-dlp / FFmpeg 调用。"
      >
        <SettingRow
          layout="stacked"
          title="yt-dlp 额外参数"
          description="例如 --no-part 或 --sleep-requests 1。"
        >
          <DraftTextArea
            value={settings.ytdlpExtraArgs}
            placeholder="--no-part --sleep-requests 1"
            ariaLabel="yt-dlp 额外参数"
            onCommit={(next) => save({ ytdlpExtraArgs: next })}
          />
        </SettingRow>

        <SettingRow
          layout="stacked"
          title="FFmpeg 额外参数"
          description="用于合并与转码步骤，例如 -movflags +faststart。"
        >
          <DraftTextArea
            value={settings.ffmpegExtraArgs}
            placeholder="-movflags +faststart"
            ariaLabel="FFmpeg 额外参数"
            onCommit={(next) => save({ ffmpegExtraArgs: next })}
          />
        </SettingRow>
      </SettingPanel>

      <SettingPanel
        title="诊断"
        description="日志级别会立即生效，用于定位解析或下载失败的原因。"
      >
        <SettingRow
          title="专家模式"
          description="显示原始命令、完整错误详情与后端日志。"
        >
          <Switch
            label="专家模式"
            checked={settings.expertMode}
            onCheckedChange={(checked) => save({ expertMode: checked })}
          />
        </SettingRow>

        <SettingRow
          layout="stacked"
          title="日志级别"
          description="低于所选级别的日志会被丢弃；debug 会记录最多信息。"
        >
          <Select
            ariaLabel="日志级别"
            className="w-full"
            value={settings.logLevel}
            options={[
              { value: "debug", label: "调试", description: "包含完整命令行与状态变化" },
              { value: "info", label: "信息", description: "默认；记录关键步骤" },
              { value: "warn", label: "警告", description: "仅记录异常与警告" },
              { value: "error", label: "错误", description: "仅记录失败" },
            ]}
            onChange={(value) => save({ logLevel: value })}
          />
        </SettingRow>

        <SettingRow
          title="保留原始输出"
          description="保留 yt-dlp 的完整 stdout / stderr，便于排查。"
          warning="日志会包含完整的原始输出，其中可能含有链接与临时文件路径。"
        >
          <Switch
            label="保留原始输出"
            checked={settings.keepRawOutput}
            onCheckedChange={(checked) => save({ keepRawOutput: checked })}
          />
        </SettingRow>
      </SettingPanel>

      {settings.expertMode ? <DiagnosticsCard /> : null}

      <SettingPanel
        title="恢复默认"
        description="重置会覆盖当前所有设置，下载目录仍留在程序所在分区。"
      >
        <SettingRow
          title="重置为默认设置"
          description="包括下载、网络、外观与高级选项。"
        >
          <Button
            variant="danger"
            size="sm"
            icon={<RotateCcw className="size-3.5" />}
            onClick={confirmReset}
          >
            重置为默认设置
          </Button>
        </SettingRow>
      </SettingPanel>
    </>
  );
}

/** Expert Mode only: live log buffer plus where the data files actually live. */
function DiagnosticsCard() {
  const logs = useSettingsStore((state) => state.logs);
  const storage = useSettingsStore((state) => state.storage);
  const loadLogs = useSettingsStore((state) => state.loadLogs);
  const clearLogs = useSettingsStore((state) => state.clearLogs);
  const refreshStorage = useSettingsStore((state) => state.refreshStorage);

  useEffect(() => {
    void loadLogs();
    void refreshStorage();
  }, [loadLogs, refreshStorage]);

  const visible = logs.slice(-200);

  const copyLogs = async () => {
    if (visible.length === 0) {
      return;
    }
    const text = visible
      .map((entry) => `${entry.at} ${entry.level.toUpperCase()} [${entry.scope}] ${entry.message}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("日志已复制", `共 ${visible.length} 行`);
    } catch (error) {
      toast.error("复制日志失败", describeError(error));
    }
  };

  const confirmClear = () => {
    useUiStore.getState().openConfirm({
      title: "清空日志缓冲区？",
      description: "只会清空当前显示的内存缓冲；磁盘上的日志文件不会被删除。",
      confirmLabel: "清空",
      onConfirm: async () => {
        try {
          await clearLogs();
          toast.success("日志缓冲区已清空");
        } catch (error) {
          toast.error("清空日志失败", describeError(error));
        }
      },
    });
  };

  const paths: { label: string; value: string; extra?: string }[] = storage
    ? [
        { label: "设置文件", value: storage.settingsFile },
        { label: "下载历史", value: storage.historyFile },
        { label: "收藏", value: storage.favoritesFile },
        { label: "日志文件", value: storage.logFile, extra: formatBytes(storage.logSizeBytes) },
      ]
    : [];

  return (
    <SettingPanel
      title="诊断信息"
      description="仅专家模式可见：最近的后端日志与数据文件位置。"
      divided={false}
      action={
        <>
          <Tooltip label="刷新日志">
            <IconButton label="刷新日志" size="xs" onClick={() => void loadLogs()}>
              <RefreshCw className="size-3.5" />
            </IconButton>
          </Tooltip>
          <Button
            size="xs"
            variant="ghost"
            icon={<Copy className="size-3.5" />}
            disabled={visible.length === 0}
            onClick={() => void copyLogs()}
          >
            复制日志
          </Button>
          <Button
            size="xs"
            variant="ghost"
            icon={<Trash2 className="size-3.5" />}
            disabled={logs.length === 0}
            onClick={confirmClear}
          >
            清空日志
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-micro tracking-[0.08em] text-content-tertiary uppercase">
            最近日志
          </span>
          <Badge tone="neutral">
            显示 {visible.length} / {logs.length} 行
          </Badge>
        </div>

        {visible.length === 0 ? (
          <Surface tone="sunken">
            <EmptyState
              icon={Terminal}
              title="暂无日志"
              description="后端还没有输出日志；运行一次解析或下载后再回来查看。"
            />
          </Surface>
        ) : (
          <Surface
            tone="sunken"
            className="selectable max-h-72 overflow-y-auto p-2.5 font-mono text-micro leading-[1.05rem]"
          >
            {visible.map((entry, index) => (
              <div key={`${entry.at}-${index}`} className="flex gap-2">
                <span className="shrink-0 text-content-tertiary">{entry.at.slice(11)}</span>
                <span
                  className={cn("w-11 shrink-0 font-semibold", LOG_LEVEL_TONES[entry.level])}
                >
                  {entry.level.toUpperCase()}
                </span>
                <span className="shrink-0 text-content-tertiary">{entry.scope}</span>
                <span className="min-w-0 flex-1 break-all text-content-secondary">
                  {entry.message}
                </span>
              </div>
            ))}
          </Surface>
        )}

        {paths.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {paths.map((row) => (
              <div
                key={row.label}
                className="row-hover flex items-center gap-3 rounded-[var(--radius-sm)] px-2 py-1.5"
              >
                <span className="w-16 shrink-0 text-caption text-content-tertiary">
                  {row.label}
                </span>
                <Tooltip label={row.value}>
                  <span className="min-w-0 flex-1 truncate font-mono text-caption text-content-secondary">
                    {row.value}
                  </span>
                </Tooltip>
                {row.extra ? (
                  <span className="shrink-0 text-caption tabular-nums text-content-tertiary">
                    {row.extra}
                  </span>
                ) : null}
                <Tooltip label="在文件管理器中显示">
                  <IconButton
                    label={`显示 ${row.label}`}
                    size="xs"
                    onClick={() => {
                      void runtimeApi
                        .revealPath(row.value)
                        .catch((error: unknown) =>
                          toast.error("无法打开位置", describeError(error)),
                        );
                    }}
                  >
                    <FolderOpen className="size-3.5" />
                  </IconButton>
                </Tooltip>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </SettingPanel>
  );
}

/* -------------------------------------------------------------------------- */
/* Skeleton                                                                   */
/* -------------------------------------------------------------------------- */

function SettingsSkeleton() {
  return (
    <div className="flex h-full min-h-0 gap-5">
      <div className="panel flex w-[13.25rem] shrink-0 flex-col gap-1 self-start p-1.5">
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-9" />
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <Skeleton className="h-10 w-64" />
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }).map((_, panel) => (
            <div key={panel} className="panel overflow-hidden">
              <div className="border-b border-line-subtle px-4 py-3">
                <Skeleton className="h-4 w-40" />
              </div>
              <div className="divide-y divide-[color:var(--border-subtle)]">
                {Array.from({ length: 3 }).map((_, row) => (
                  <div key={row} className="flex items-center justify-between gap-6 px-4 py-3.5">
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3.5 w-48" />
                      <Skeleton className="h-3 w-72" />
                    </div>
                    <Skeleton className="h-6 w-11" rounded="full" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
