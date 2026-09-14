/**
 * Home — from a pasted link to a queued download in as few steps as possible.
 *
 * The page owns a small state machine (idle → parsing → parsed | error) and hands the
 * result to the preview, the format selector and the download rail. Nothing here
 * fabricates progress: every action calls the backend and reflects what it returns.
 */

import { AnimatePresence, motion } from "framer-motion";
import { CheckSquare, Download, Link2, ListVideo, ShieldOff, Square, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { IpcError } from "@/api/client";
import * as mediaApi from "@/api/media";
import { DownloadPanel } from "@/components/download/DownloadPanel";
import { FormatSelector } from "@/components/download/FormatSelector";
import { MediaPreview } from "@/components/download/MediaPreview";
import { UrlComposer, type ComposerStatus } from "@/components/download/UrlComposer";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Controls";
import { EmptyState, ErrorState } from "@/components/ui/Feedback";
import { Skeleton } from "@/components/ui/Progress";
import { Badge, SectionHeader } from "@/components/ui/Surface";
import { cn } from "@/lib/cn";
import { bus, on } from "@/lib/bus";
import { formatDuration } from "@/lib/format";
import { duration, ease, listVariants, itemVariants } from "@/lib/motion";
import { useSettingsStore } from "@/stores/settings";
import { useTasksStore } from "@/stores/tasks";
import { useUiStore } from "@/stores/ui";
import type { FormatOption, MediaProbe, UrlCheck } from "@/types/models";

export function HomePage() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<ComposerStatus>("idle");
  const [checks, setChecks] = useState<UrlCheck[]>([]);
  const [probe, setProbe] = useState<MediaProbe | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [outputOverride, setOutputOverride] = useState<string | null>(null);
  /** True when the current parse (and therefore the download) skips browser cookies. */
  const [ignoreCookies, setIgnoreCookies] = useState(false);

  const settings = useSettingsStore((state) => state.settings);
  /** Whether browser/file cookies are configured (drives the no-cookie fallback). */
  const cookiesConfigured =
    (settings?.cookies.mode ?? "none") !== "none";
  const enqueue = useTasksStore((state) => state.enqueue);
  const setPage = useUiStore((state) => state.setPage);
  const pendingUrl = useUiStore((state) => state.pendingUrl);
  const consumePendingUrl = useUiStore((state) => state.consumePendingUrl);

  const defaultOutputDir = settings?.downloads.outputDir ?? "";
  const outputDir = outputOverride ?? defaultOutputDir;
  const validUrls = useMemo(() => checks.filter((check) => check.valid), [checks]);
  const isCollection = probe !== null && probe.kind !== "video";

  const selectedOption = useMemo(() => {
    if (!probe) {
      return null;
    }
    return (
      probe.options.find((option) => option.id === selectedId) ??
      probe.options.find((option) => option.recommended) ??
      probe.options[0] ??
      null
    );
  }, [probe, selectedId]);

  /** How many tasks the Start button will create. */
  const itemCount = useMemo(() => {
    if (!probe) {
      return 0;
    }
    if (!isCollection) {
      return validUrls.length || 1;
    }
    const selectedEntries = probe.entries.filter((entry) => !excluded.has(entry.url));
    return selectedEntries.length + Math.max(0, validUrls.length - 1);
  }, [probe, isCollection, excluded, validUrls]);

  // A link handed over from Favorites or History lands straight in the composer.
  useEffect(() => {
    const url = pendingUrl ?? consumePendingUrl();
    if (url) {
      setText(url);
      setStatus("idle");
    }
  }, [pendingUrl, consumePendingUrl]);

  const reset = useCallback(() => {
    setText("");
    setChecks([]);
    setProbe(null);
    setSelectedId(null);
    setStatus("idle");
    setErrorMessage(null);
    setErrorDetail(null);
    setErrorHint(null);
    setSuccessMessage(null);
    setExcluded(new Set());
    setIgnoreCookies(false);
  }, []);

  /**
   * Resolve the pasted link.
   *
   * `options.ignoreCookies` re-runs the parse without browser cookies. It exists
   * because a browser cookie store can be unreadable (locked by a running Edge, or
   * protected by app-bound encryption) while the video itself needs no login at all —
   * in that case the correct behaviour is to parse again without cookies rather than
   * to give up.
   */
  const parse = useCallback(
    async (raw?: string, options?: { ignoreCookies?: boolean }) => {
      const source = (raw ?? text).trim();
      if (!source) {
        return;
      }

      const withoutCookies = options?.ignoreCookies ?? false;

      setErrorMessage(null);
      setErrorDetail(null);
      setErrorHint(null);
      setSuccessMessage(null);
      setStatus("parsing");

      try {
        const validated = await mediaApi.validateUrls(source);
        setChecks(validated);

        const valid = validated.filter((check) => check.valid);
        if (valid.length === 0) {
          setStatus("error");
          setErrorMessage(
            validated[0]?.reason ?? "没有识别到有效的视频链接，请检查后重试。",
          );
          return;
        }

        const first = valid[0];
        const result = await mediaApi.probeUrl(first.url, first.playlist, withoutCookies);
        setProbe(result);
        setSelectedId(
          result.options.find((option) => option.recommended)?.id ??
            result.options[0]?.id ??
            null,
        );
        setExcluded(new Set());
        setIgnoreCookies(withoutCookies);
        setStatus("parsed");
        setSuccessMessage(
          result.kind === "video"
            ? `已解析：${result.formats.length} 个格式可用`
            : `已解析：${result.entries.length} 个条目`,
        );
      } catch (error) {
        setStatus("error");
        const ipc = error instanceof IpcError ? error : null;
        setErrorMessage(ipc?.message ?? String(error));
        setErrorDetail(ipc?.detail ?? null);
        setErrorHint(ipc?.hint ?? null);
        // A failed attempt must not leave a stale "cookies were skipped" flag behind.
        setIgnoreCookies(withoutCookies);
      }
    },
    [text],
  );

  // Ctrl+Enter from anywhere in the window, and Ctrl+V of a link.
  useEffect(() => {
    const disposeSubmit = on(bus.submit, () => {
      void parse();
    });
    const disposePaste = on<string>(bus.paste, (value) => {
      if (value) {
        setText(value);
        setStatus("idle");
      }
    });
    return () => {
      disposeSubmit();
      disposePaste();
    };
  }, [parse]);

  const start = useCallback(async () => {
    if (!probe) {
      return;
    }

    const outputDirForRequest = outputOverride ?? null;

    if (!isCollection) {
      const selection = toSelection(selectedOption);
      const requests = validUrls.length > 0 ? validUrls : [];
      const payload = (requests.length > 0 ? requests : [{ url: probe.webpageUrl }]).map(
        (item, index) => ({
          url: item.url,
          selection: index === 0 ? selection : null,
          outputDir: outputDirForRequest,
          titleHint: index === 0 ? probe.title : null,
          thumbnailHint: index === 0 ? probe.thumbnail : null,
          uploaderHint: index === 0 ? probe.uploader : null,
          durationHint: index === 0 ? probe.duration : null,
          // Honour the fallback the user chose at parse time: a download that was
          // resolved without cookies must not suddenly require them.
          ignoreCookies: ignoreCookies || null,
        }),
      );
      const ids = await enqueue(payload);
      if (ids.length > 0) {
        setPage("queue");
      }
      return;
    }

    // Collections: one task per selected entry; the backend resolves each video's
    // best format when it starts.
    const selected = probe.entries.filter((entry) => !excluded.has(entry.url));
    const payload = selected.map((entry) => ({
      url: entry.url,
      selection: null,
      outputDir: outputDirForRequest,
      titleHint: entry.title,
      thumbnailHint: entry.thumbnail,
      uploaderHint: entry.uploader,
      durationHint: entry.duration,
      ignoreCookies: ignoreCookies || null,
    }));

    if (payload.length === 0) {
      return;
    }
    const ids = await enqueue(payload);
    if (ids.length > 0) {
      setPage("queue");
    }
  }, [probe, isCollection, selectedOption, validUrls, excluded, enqueue, setPage, outputOverride, ignoreCookies]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <SectionHeader
        title="新建下载"
        description="粘贴链接，解析后选择格式即可开始下载"
        action={
          <div className="flex items-center gap-2 text-caption text-content-tertiary">
            <Sparkles className="size-3.5 text-accent" />
            默认使用 WebM + Opus，不会二次编码
          </div>
        }
      />

      <UrlComposer
        status={status}
        checks={checks}
        value={text}
        onValueChange={(value) => {
          setText(value);
          if (status === "error" || status === "parsed") {
            setStatus("idle");
          }
        }}
        onSubmit={() => void parse()}
        onCancel={() => {
          void mediaApi.cancelProbe();
          setStatus("idle");
        }}
        onClear={reset}
        errorMessage={errorMessage}
        successMessage={successMessage}
        autoFocus
      />

      <AnimatePresence mode="wait" initial={false}>
        {status === "parsing" ? (
          <motion.div
            key="loading"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: duration.normal, ease: ease.out }}
            className="flex min-h-0 flex-1 gap-4"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="panel flex gap-4 p-4">
                <Skeleton className="aspect-video w-[13.5rem]" />
                <div className="flex-1 space-y-3 py-1">
                  <Skeleton className="h-5 w-3/4" />
                  <Skeleton className="h-3.5 w-1/3" />
                  <div className="grid grid-cols-4 gap-4 pt-4">
                    {Array.from({ length: 4 }).map((_, index) => (
                      <div key={index} className="space-y-2">
                        <Skeleton className="h-2.5 w-12" />
                        <Skeleton className="h-3.5 w-16" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                {Array.from({ length: 6 }).map((_, index) => (
                  <Skeleton key={index} className="h-14" />
                ))}
              </div>
            </div>
            <div className="panel w-[20rem] shrink-0 p-4">
              <Skeleton className="h-5 w-24" />
              <div className="mt-4 space-y-3">
                <Skeleton className="h-16" />
                <Skeleton className="h-24" />
                <Skeleton className="h-11" />
              </div>
            </div>
          </motion.div>
        ) : status === "error" ? (
          <motion.div
            key="error"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: duration.normal, ease: ease.out }}
            className="flex min-h-0 flex-1 items-start justify-center pt-6"
          >
            <ErrorState
              className="max-w-xl"
              title="无法解析视频"
              description={errorMessage ?? "请检查链接或网络连接。"}
              hint={errorHint}
              // The raw yt-dlp tail is only shown when Expert Mode is on.
              detail={
                useSettingsStore.getState().settings?.advanced.expertMode
                  ? errorDetail
                  : null
              }
              onRetry={() => void parse()}
              extraAction={
                // Only offered when cookies are actually configured and this attempt
                // did not already skip them — otherwise it would be a no-op button.
                cookiesConfigured && !ignoreCookies ? (
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<ShieldOff className="size-3.5" />}
                    onClick={() => void parse(undefined, { ignoreCookies: true })}
                  >
                    不使用 Cookie 重试
                  </Button>
                ) : null
              }
              onSecondary={reset}
              secondaryLabel="清空"
            />
            {cookiesConfigured && !ignoreCookies ? (
              <p className="mt-3 text-center text-caption text-content-tertiary">
                浏览器 Cookie 读取失败不会阻止下载：可以选择不使用 Cookie 重新解析。
              </p>
            ) : null}
          </motion.div>
        ) : probe ? (
          <motion.div
            key="parsed"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: duration.normal, ease: ease.out }}
            className="flex min-h-0 flex-1 gap-4"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden">
              <MediaPreview probe={probe} />

              {isCollection ? (
                <PlaylistPicker
                  probe={probe}
                  excluded={excluded}
                  onToggle={(url) =>
                    setExcluded((current) => {
                      const next = new Set(current);
                      if (next.has(url)) {
                        next.delete(url);
                      } else {
                        next.add(url);
                      }
                      return next;
                    })
                  }
                  onSelectAll={() => setExcluded(new Set())}
                  onSelectNone={() =>
                    setExcluded(new Set(probe.entries.map((entry) => entry.url)))
                  }
                />
              ) : (
                <FormatSelector
                  probe={probe}
                  selectedId={selectedOption?.id ?? null}
                  onSelect={(option) => setSelectedId(option.id)}
                  className="min-h-0 flex-1"
                />
              )}
            </div>

            <DownloadPanel
              probe={probe}
              option={isCollection ? null : selectedOption}
              itemCount={itemCount}
              outputDir={outputDir}
              onOutputDirChange={setOutputOverride}
              onStart={() => void start()}
              busy={false}
            />
          </motion.div>
        ) : (
          <motion.div
            key="empty"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: duration.normal, ease: ease.out }}
            className="flex min-h-0 flex-1 items-start justify-center pt-4"
          >
            <EmptyState
              className="max-w-2xl"
              icon={Link2}
              title="还没有下载"
              description="解析一个视频开始使用。支持单个视频、多个链接、播放列表、频道与 Shorts。"
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Download className="size-3.5" />}
                  onClick={() => setPage("favorites")}
                >
                  从收藏中选择
                </Button>
              }
              secondaryAction={
                <Button variant="ghost" size="sm" onClick={() => setPage("history")}>
                  查看历史
                </Button>
              }
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Playlist / channel entry picker. */
function PlaylistPicker({
  probe,
  excluded,
  onToggle,
  onSelectAll,
  onSelectNone,
}: {
  probe: MediaProbe;
  excluded: Set<string>;
  onToggle: (url: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
}) {
  const selectedCount = probe.entries.length - excluded.size;

  return (
    <section className="panel flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2">
          <ListVideo className="size-4 text-content-tertiary" />
          <span className="text-label font-medium text-content">列表内容</span>
          <Badge tone={selectedCount > 0 ? "accent" : "neutral"}>
            已选 {selectedCount} / {probe.entries.length}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            icon={<CheckSquare className="size-3.5" />}
            onClick={onSelectAll}
          >
            全选
          </Button>
          <Button
            size="xs"
            variant="ghost"
            icon={<Square className="size-3.5" />}
            onClick={onSelectNone}
          >
            全不选
          </Button>
        </div>
      </div>

      <motion.ul
        variants={listVariants}
        initial="initial"
        animate="animate"
        className="min-h-0 flex-1 divide-y divide-[color:var(--border-subtle)] overflow-y-auto"
      >
        {probe.entries.map((entry, index) => {
          const checked = !excluded.has(entry.url);
          return (
            <motion.li key={`${entry.url}-${index}`} variants={itemVariants}>
              <div
                className={cn(
                  "flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover",
                  !checked && "opacity-55",
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => onToggle(entry.url)}
                  label={<span className="sr-only">选择 {entry.title}</span>}
                />
                <span className="w-6 shrink-0 text-right text-micro tabular-nums text-content-tertiary">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-label text-content" title={entry.title}>
                    {entry.title}
                  </span>
                  {entry.uploader ? (
                    <span className="block truncate text-micro text-content-tertiary">
                      {entry.uploader}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-caption tabular-nums text-content-tertiary">
                  {formatDuration(entry.duration)}
                </span>
              </div>
            </motion.li>
          );
        })}
      </motion.ul>
    </section>
  );
}

/** Convert a selector row into the payload the backend expects. */
function toSelection(option: FormatOption | null) {
  if (!option) {
    return null;
  }
  return {
    kind: option.kind,
    label: option.label,
    container: option.container,
    videoFormatId: option.videoFormatId,
    audioFormatId: option.audioFormatId,
    singleFormatId: option.singleFormatId,
    height: option.height,
    fps: option.fps,
    videoCodec: option.videoCodec,
    audioCodec: option.audioCodec,
    hdr: option.hdr,
    sizeBytes: option.sizeBytes,
    mode: option.kind === "videoWithAudio" ? "video+audio" : "single",
  };
}
