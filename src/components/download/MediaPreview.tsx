/** The resolved-media preview: thumbnail, title and the metadata worth showing. */

import { motion } from "framer-motion";
import { Clock3, Eye, Radio, User2 } from "lucide-react";
import { useState } from "react";

import { Badge, MetaItem } from "@/components/ui/Surface";
import { cn } from "@/lib/cn";
import { formatCount, formatDuration, formatUploadDate } from "@/lib/format";
import { duration, ease } from "@/lib/motion";
import type { MediaProbe } from "@/types/models";

export function MediaPreview({
  probe,
  className,
}: {
  probe: MediaProbe;
  className?: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const isCollection = probe.kind !== "video";

  const kindLabel =
    probe.kind === "playlist" ? "播放列表" : probe.kind === "channel" ? "频道" : "视频";

  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: duration.slow, ease: ease.out }}
      className={cn("panel overflow-hidden", className)}
    >
      <div className="flex gap-4 p-4">
        <div className="relative aspect-video w-[13.5rem] shrink-0 overflow-hidden rounded-[var(--radius-md)] border border-line-subtle bg-surface-sunken">
          {probe.thumbnail && !imageFailed ? (
            <motion.img
              src={probe.thumbnail}
              alt=""
              initial={{ opacity: 0, scale: 1.02 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: duration.slow, ease: ease.out }}
              onError={() => setImageFailed(true)}
              className="size-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex size-full items-center justify-center text-content-tertiary">
              <Radio className="size-6" strokeWidth={1.6} />
            </div>
          )}

          {probe.duration ? (
            <span className="absolute right-1.5 bottom-1.5 rounded-[var(--radius-xs)] bg-black/72 px-1.5 py-px text-micro font-medium tabular-nums text-white">
              {formatDuration(probe.duration)}
            </span>
          ) : null}

          {probe.isLive ? (
            <span className="absolute top-1.5 left-1.5 rounded-full bg-danger px-1.5 py-px text-micro font-semibold text-white">
              直播中
            </span>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start gap-2">
            <h2
              className="min-w-0 flex-1 text-title font-semibold tracking-[-0.016em] text-content"
              title={probe.title}
            >
              <span className="line-clamp-2">{probe.title}</span>
            </h2>
            <Badge tone="accent">{kindLabel}</Badge>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-content-tertiary">
            {probe.uploader ? (
              <span className="inline-flex items-center gap-1.5">
                <User2 className="size-3.5" />
                {probe.uploader}
              </span>
            ) : null}
            {probe.duration && !isCollection ? (
              <span className="inline-flex items-center gap-1.5">
                <Clock3 className="size-3.5" />
                {formatDuration(probe.duration)}
              </span>
            ) : null}
            {probe.viewCount ? (
              <span className="inline-flex items-center gap-1.5">
                <Eye className="size-3.5" />
                {formatCount(probe.viewCount)} 次观看
              </span>
            ) : null}
            {probe.uploadDate ? <span>{formatUploadDate(probe.uploadDate)}</span> : null}
          </div>

          <div className="mt-auto grid grid-cols-2 gap-x-6 gap-y-2.5 pt-3 sm:grid-cols-4">
            <MetaItem label="来源" value={probe.extractor ?? "—"} />
            {isCollection ? (
              <>
                <MetaItem
                  label="条目"
                  value={`${probe.entries.length}${probe.playlistCount ? ` / ${probe.playlistCount}` : ""}`}
                />
                <MetaItem
                  label="字幕"
                  value={
                    probe.subtitles.length > 0
                      ? `${probe.subtitles.length} 种`
                      : probe.automaticCaptions.length > 0
                        ? "仅自动"
                        : "无"
                  }
                />
                <MetaItem label="章节" value={probe.chapters.length || "无"} />
              </>
            ) : (
              <>
                <MetaItem label="格式" value={`${probe.formats.length} 个可选`} />
                <MetaItem
                  label="字幕"
                  value={
                    probe.subtitles.length > 0
                      ? `${probe.subtitles.length} 种`
                      : probe.automaticCaptions.length > 0
                        ? "仅自动"
                        : "无"
                  }
                />
                <MetaItem
                  label="章节"
                  value={probe.chapters.length > 0 ? `${probe.chapters.length} 段` : "无"}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </motion.section>
  );
}
