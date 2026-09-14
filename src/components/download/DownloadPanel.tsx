/** The right-hand rail: where the file goes, what will be embedded, and the action. */

import { motion } from "framer-motion";
import {
  Captions,
  CheckCircle2,
  Download,
  FileImage,
  FolderOpen,
  ImageIcon,
  ListVideo,
  Pencil,
  Settings2,
  Tags,
  type LucideIcon,
} from "lucide-react";

import { Button, IconButton } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Overlay";
import { Badge, StatusDot } from "@/components/ui/Surface";
import { cn } from "@/lib/cn";
import { pickDirectory } from "@/lib/dialog";
import { containerLabel, formatBytes, shortenPath } from "@/lib/format";
import { duration, ease } from "@/lib/motion";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import type { FormatOption, MediaProbe } from "@/types/models";

export interface DownloadPanelProps {
  probe: MediaProbe | null;
  option: FormatOption | null;
  /** Number of downloads that will be created. */
  itemCount: number;
  outputDir: string;
  onOutputDirChange: (path: string) => void;
  onStart: () => void;
  busy?: boolean;
  className?: string;
}

export function DownloadPanel({
  probe,
  option,
  itemCount,
  outputDir,
  onOutputDirChange,
  onStart,
  busy = false,
  className,
}: DownloadPanelProps) {
  const settings = useSettingsStore((state) => state.settings);
  const runtime = useSettingsStore((state) => state.runtime);
  const setPage = useUiStore((state) => state.setPage);

  const downloads = settings?.downloads;
  const ready = runtime?.complete ?? false;
  const canStart = probe !== null && itemCount > 0 && ready && !busy;

  const traits: { icon: LucideIcon; label: string; active: boolean }[] = [
    { icon: Tags, label: "写入元数据", active: downloads?.embedMetadata ?? false },
    { icon: ImageIcon, label: "嵌入封面", active: downloads?.embedThumbnail ?? false },
    { icon: FileImage, label: "保存缩略图", active: downloads?.writeThumbnail ?? false },
    { icon: ListVideo, label: "写入章节", active: downloads?.embedChapters ?? false },
    { icon: Captions, label: "下载字幕", active: downloads?.writeSubtitles ?? false },
  ];

  const activeTraits = traits.filter((trait) => trait.active);

  return (
    <motion.aside
      layout
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: duration.slow, ease: ease.out }}
      className={cn("panel flex w-[20rem] shrink-0 flex-col gap-4 p-4", className)}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-heading font-semibold tracking-[-0.012em] text-content">
          下载设置
        </h3>
        <Tooltip label="打开完整设置">
          <IconButton label="打开设置" onClick={() => setPage("settings")}>
            <Settings2 className="size-4" />
          </IconButton>
        </Tooltip>
      </div>

      {/* Destination ------------------------------------------------------- */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-micro tracking-[0.08em] text-content-tertiary uppercase">
            保存位置
          </span>
          <button
            type="button"
            onClick={() => setPage("settings")}
            className="text-micro text-accent hover:text-accent-hover"
          >
            默认目录
          </button>
        </div>

        <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-line bg-surface-muted px-2.5 py-2">
          <FolderOpen className="size-4 shrink-0 text-content-tertiary" />
          <span
            className="min-w-0 flex-1 truncate text-caption text-content-secondary"
            title={outputDir}
          >
            {shortenPath(outputDir, 40)}
          </span>
          <Tooltip label="更改目录">
            <IconButton
              label="更改目录"
              size="xs"
              onClick={async () => {
                const picked = await pickDirectory();
                if (picked) {
                  onOutputDirChange(picked);
                }
              }}
            >
              <Pencil className="size-3.5" />
            </IconButton>
          </Tooltip>
        </div>
      </div>

      {/* What will be produced --------------------------------------------- */}
      <div className="flex flex-col gap-2">
        <span className="text-micro tracking-[0.08em] text-content-tertiary uppercase">
          输出
        </span>

        {option ? (
          <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-line bg-surface-muted p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-label font-semibold text-content">{option.label}</span>
              <Badge tone={option.container === "webm" ? "accent" : "neutral"}>
                {containerLabel(option.container)}
              </Badge>
            </div>
            <p className="text-caption text-content-tertiary">{option.detail}</p>
            <div className="flex items-center justify-between text-caption text-content-secondary">
              <span>
                {option.videoCodec ?? "—"} / {option.audioCodec ?? "—"}
              </span>
              <span className="tabular-nums">
                {option.sizeBytes ? `≈ ${formatBytes(option.sizeBytes)}` : "大小未知"}
              </span>
            </div>
          </div>
        ) : (
          <div className="rounded-[var(--radius-md)] border border-dashed border-line px-3 py-4 text-center text-caption text-content-tertiary">
            解析链接后选择格式
          </div>
        )}

        {activeTraits.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {activeTraits.map((trait) => (
              <li
                key={trait.label}
                className="flex items-center gap-2 text-caption text-content-tertiary"
              >
                <CheckCircle2 className="size-3.5 text-success" />
                {trait.label}
              </li>
            ))}
          </ul>
        ) : null}

        {probe && probe.kind !== "video" ? (
          <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-line-subtle bg-surface-muted px-3 py-2 text-caption text-content-secondary">
            <ListVideo className="size-3.5 text-content-tertiary" />
            将创建 {itemCount} 个下载任务
            {probe.playlistCount && probe.playlistCount > probe.entries.length ? (
              <span className="text-content-tertiary">
                （已加载 {probe.entries.length} / {probe.playlistCount}）
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-auto flex flex-col gap-2.5">
        {!ready ? (
          <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-warning/30 bg-warning-soft px-3 py-2 text-caption text-warning">
            <StatusDot tone="warning" className="mt-1.5" />
            <span className="flex-1">
              运行库未就绪，请先在「关于」页检查 yt-dlp 与 FFmpeg 路径。
            </span>
          </div>
        ) : null}

        <Button
          variant="primary"
          size="lg"
          fullWidth
          disabled={!canStart}
          loading={busy}
          icon={<Download className="size-4" />}
          onClick={onStart}
        >
          {itemCount > 1 ? `开始下载 ${itemCount} 个` : "开始下载"}
        </Button>

        <p className="text-center text-micro text-content-tertiary">
          {downloads?.keepStreams
            ? "保留分离的音视频流"
            : "合并完成后自动清理临时文件"}
        </p>
      </div>
    </motion.aside>
  );
}
