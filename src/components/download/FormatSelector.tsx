/**
 * The format selector.
 *
 * Rows are produced by the backend (video+audio pairs, muxed files and audio-only
 * tracks) and filtered here. Selection is a radio card so the chosen quality is
 * unambiguous, and the list is virtualised by simple windowing only when it grows
 * beyond what fits comfortably.
 */

import { motion } from "framer-motion";
import { Film, Music4, Search, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import { SegmentedControl, TextInput } from "@/components/ui/Controls";
import { Badge } from "@/components/ui/Surface";
import { RadioCard, RadioCardGroup } from "@/components/ui/Selection";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { duration, ease } from "@/lib/motion";
import type { FormatOption, MediaProbe } from "@/types/models";

type KindFilter = "all" | "video" | "muxed" | "audio";

export interface FormatSelectorProps {
  probe: MediaProbe;
  selectedId: string | null;
  onSelect: (option: FormatOption) => void;
  className?: string;
}

export function FormatSelector({
  probe,
  selectedId,
  onSelect,
  className,
}: FormatSelectorProps) {
  const [filter, setFilter] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const video = probe.options.filter(
      (option) => option.kind === "videoWithAudio" || option.kind === "videoOnly",
    ).length;
    const muxed = probe.options.filter((option) => option.kind === "progressive").length;
    const audio = probe.options.filter((option) => option.kind === "audioOnly").length;
    return { all: probe.options.length, video, muxed, audio };
  }, [probe.options]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return probe.options.filter((option) => {
      const matchesKind =
        filter === "all"
          ? true
          : filter === "video"
            ? option.kind === "videoWithAudio" || option.kind === "videoOnly"
            : filter === "muxed"
              ? option.kind === "progressive"
              : option.kind === "audioOnly";

      if (!matchesKind) {
        return false;
      }
      if (!needle) {
        return true;
      }
      return (
        option.label.toLowerCase().includes(needle) ||
        option.detail.toLowerCase().includes(needle) ||
        (option.videoCodec ?? "").toLowerCase().includes(needle) ||
        (option.audioCodec ?? "").toLowerCase().includes(needle) ||
        option.container.toLowerCase().includes(needle)
      );
    });
  }, [probe.options, filter, query]);

  const hasAudioOnly = counts.audio > 0;

  return (
    <section className={cn("flex min-h-0 flex-col gap-3", className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-heading font-semibold tracking-[-0.012em] text-content">
            选择格式
          </h3>
          <span className="text-caption text-content-tertiary">
            默认保持原始编码，不做二次压缩
          </span>
        </div>

        <div className="flex items-center gap-2">
          <TextInput
            inputSize="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选分辨率 / 编码"
            aria-label="筛选格式"
            icon={<Search className="size-3.5" />}
            className="w-44"
          />
          <SegmentedControl<KindFilter>
            layoutId="format-filter"
            size="sm"
            value={filter}
            onChange={setFilter}
            segments={[
              { value: "all", label: "全部", badge: String(counts.all) },
              { value: "video", label: "视频", badge: String(counts.video) },
              { value: "muxed", label: "单文件", badge: String(counts.muxed) },
              ...(hasAudioOnly
                ? [{ value: "audio" as KindFilter, label: "音频", badge: String(counts.audio) }]
                : []),
            ]}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Search className="size-4 text-content-tertiary" />
            <p className="text-label text-content-secondary">没有匹配的格式</p>
            <p className="text-caption text-content-tertiary">
              试着清空筛选条件，或换一个关键词
            </p>
          </div>
        ) : (
          <RadioCardGroup label="可选格式" className="pb-1">
            {visible.map((option, index) => (
              <motion.div
                key={option.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: duration.normal,
                  ease: ease.out,
                  // Only the first screenful staggers; later rows appear instantly so
                  // a long list never feels slow.
                  delay: index < 14 ? index * 0.014 : 0,
                }}
              >
                <FormatRow
                  option={option}
                  selected={option.id === selectedId}
                  onSelect={() => onSelect(option)}
                />
              </motion.div>
            ))}
          </RadioCardGroup>
        )}
      </div>
    </section>
  );
}

function FormatRow({
  option,
  selected,
  onSelect,
}: {
  option: FormatOption;
  selected: boolean;
  onSelect: () => void;
}) {
  const icon =
    option.kind === "audioOnly" ? (
      <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-line bg-surface-muted text-content-tertiary">
        <Music4 className="size-4" />
      </span>
    ) : (
      <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-line bg-surface-muted text-content-tertiary">
        <Film className="size-4" />
      </span>
    );

  // The resolution is the headline; everything else is supporting detail.
  const trailing = (
    <span className="hidden shrink-0 items-center gap-2 pl-2 text-right sm:flex">
      {option.hdr ? (
        <Badge tone="info" className="px-1.5">
          HDR
        </Badge>
      ) : null}
      {option.kind === "videoWithAudio" ? (
        <Badge tone="neutral" className="px-1.5">
          视频 + 音频
        </Badge>
      ) : null}
      <span className="w-20 text-caption tabular-nums text-content-secondary">
        {option.sizeBytes ? formatBytes(option.sizeBytes) : "大小未知"}
      </span>
    </span>
  );

  return (
    <RadioCard
      compact
      selected={selected}
      recommended={option.recommended}
      onSelect={onSelect}
      leading={icon}
      title={
        <span className="inline-flex items-center gap-1.5">
          {option.label}
          {option.fps && option.fps >= 50 ? (
            <span className="text-micro font-normal text-content-tertiary">
              {Math.round(option.fps)}fps
            </span>
          ) : null}
        </span>
      }
      subtitle={
        <span className="inline-flex items-center gap-1.5">
          {option.recommended ? (
            <Sparkles className="size-3 text-accent" aria-label="推荐" />
          ) : null}
          {option.detail}
        </span>
      }
      trailing={trailing}
    />
  );
}
