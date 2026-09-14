/**
 * Favorites — the shelf of links the user wants to come back to.
 *
 * A favourite is a link, not a file, so every action here is about the link itself:
 * hand it to the composer, copy it, or take it off the shelf. New favourites are
 * created by the star button in the composer; this page only reads the store and
 * can re-star an entry whose state changed underneath it.
 */

import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import {
  Clock3,
  Copy,
  Download,
  ExternalLink,
  Film,
  History as HistoryIcon,
  Sparkles,
  Star,
  StarOff,
  User2,
} from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";

import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Feedback";
import { Tooltip } from "@/components/ui/Overlay";
import { Skeleton } from "@/components/ui/Progress";
import { SectionHeader } from "@/components/ui/Surface";
import { cn } from "@/lib/cn";
import { formatCount, formatDuration, formatRelative } from "@/lib/format";
import { duration, ease, itemVariants, listVariants } from "@/lib/motion";
import { openUrl } from "@/api/runtime";
import { useLibraryStore } from "@/stores/library";
import { useSettingsStore } from "@/stores/settings";
import { toast } from "@/stores/toasts";
import { useUiStore } from "@/stores/ui";
import type { FavoriteEntry } from "@/types/models";

/** The hover lift, expressed with the motion tokens rather than magic numbers. */
const LIFT: CSSProperties = {
  transitionProperty: "transform",
  transitionDuration: `${duration.normal * 1000}ms`,
  transitionTimingFunction: "var(--ease-out)",
};

const REDUCED_LIST: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.02 } },
};

const REDUCED_ITEM: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: duration.fast, ease: ease.standard } },
  exit: { opacity: 0, transition: { duration: duration.fast, ease: ease.standard } },
};

/** Favourite timestamps arrive as `YYYY-MM-DD HH:MM:SS`; parse defensively. */
function timestamp(value: string): number {
  const parsed = Date.parse(value.replace(" ", "T"));
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Honour the OS preference and the in-app Motion setting.
 *
 * The setting wins when it is explicit, exactly like `prefersReducedMotion()` in the
 * settings store — but reactive, so switching it takes effect without a reload.
 */
function useMotionReduced(): boolean {
  const setting = useSettingsStore(
    (state) => state.settings?.appearance.motion ?? "system",
  );
  const system = useReducedMotion() ?? false;
  return setting === "reduced" || (setting === "system" && system);
}

export function FavoritesPage() {
  const favorites = useLibraryStore((state) => state.favorites);
  const loading = useLibraryStore((state) => state.loading);
  const setPage = useUiStore((state) => state.setPage);
  const reduce = useMotionReduced();

  // Newest save first, matching how the rest of the app orders the library.
  const cards = useMemo(
    () =>
      [...favorites].sort(
        (left, right) => timestamp(right.createdAt) - timestamp(left.createdAt),
      ),
    [favorites],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <SectionHeader
        title="收藏"
        description={
          favorites.length > 0
            ? `共 ${formatCount(favorites.length)} 个收藏，按保存时间从新到旧排列`
            : "把想下载的链接先存起来，之后随时回来解析"
        }
        action={
          <div className="flex items-center gap-2 text-caption text-content-tertiary">
            <Star className="size-3.5 text-accent" />
            在新建下载页解析后点击星标即可收藏
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
        {loading ? (
          <FavoritesSkeleton />
        ) : cards.length === 0 ? (
          <div className="panel">
            <EmptyState
              icon={Star}
              title="还没有收藏"
              description="在新建下载页解析任意链接后点击星标，就会出现在这里。收藏只保存链接，不占用磁盘空间。"
              action={
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Download className="size-3.5" />}
                  onClick={() => setPage("home")}
                >
                  去新建下载
                </Button>
              }
              secondaryAction={
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<HistoryIcon className="size-3.5" />}
                  onClick={() => setPage("history")}
                >
                  查看下载历史
                </Button>
              }
            />
          </div>
        ) : (
          <motion.ul
            variants={reduce ? REDUCED_LIST : listVariants}
            initial="initial"
            animate="animate"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
          >
            <AnimatePresence initial={false}>
              {cards.map((entry) => (
                <FavoriteCard key={entry.id} entry={entry} reduce={reduce} />
              ))}
            </AnimatePresence>
          </motion.ul>
        )}
      </div>
    </div>
  );
}

function FavoriteCard({ entry, reduce }: { entry: FavoriteEntry; reduce: boolean }) {
  const [imageFailed, setImageFailed] = useState(false);
  // Reading the live state keeps the button correct even if something else removes
  // the entry while this page is on screen; the same call decides star vs unstar.
  const isStarred = useLibraryStore((state) => state.isStarred);
  const star = useLibraryStore((state) => state.star);
  const unstar = useLibraryStore((state) => state.unstar);
  const copyLink = useLibraryStore((state) => state.copyLink);
  const sendToComposer = useUiStore((state) => state.sendToComposer);
  const openConfirm = useUiStore((state) => state.openConfirm);

  const starred = isStarred(entry.url);

  const toggleStar = () => {
    if (starred) {
      openConfirm({
        title: "取消收藏？",
        description: `“${entry.title}”会从收藏中移除，已下载的文件不受影响。`,
        confirmLabel: "取消收藏",
        danger: true,
        onConfirm: () => unstar(entry.id),
      });
      return;
    }
    void star({
      url: entry.url,
      title: entry.title,
      thumbnail: entry.thumbnail,
      uploader: entry.uploader,
      duration: entry.duration,
      note: entry.note,
    });
  };

  return (
    <motion.li
      variants={reduce ? REDUCED_ITEM : itemVariants}
      className="min-w-0"
    >
      <article
        className={cn(
          "panel group flex h-full flex-col overflow-hidden",
          !reduce && "hover:-translate-y-0.5",
        )}
        style={reduce ? undefined : LIFT}
      >
        <div className="relative aspect-video w-full overflow-hidden bg-surface-sunken">
          {entry.thumbnail && !imageFailed ? (
            <img
              src={entry.thumbnail}
              alt=""
              loading="lazy"
              onError={() => setImageFailed(true)}
              className={cn(
                "size-full object-cover",
                !reduce && "group-hover:scale-[1.03]",
              )}
              style={reduce ? undefined : LIFT}
            />
          ) : (
            <div className="flex size-full items-center justify-center text-content-tertiary">
              <Film className="size-6" strokeWidth={1.6} />
            </div>
          )}
          {entry.duration ? (
            <span className="absolute right-1.5 bottom-1.5 rounded-[var(--radius-xs)] bg-background/80 px-1.5 py-px text-micro font-medium tabular-nums text-content">
              {formatDuration(entry.duration)}
            </span>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
          <h3
            className="line-clamp-2 text-body font-medium text-content"
            title={entry.title}
          >
            {entry.title}
          </h3>

          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption text-content-tertiary">
            {entry.uploader ? (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <User2 className="size-3.5 shrink-0" />
                <span className="truncate">{entry.uploader}</span>
              </span>
            ) : null}
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <Clock3 className="size-3.5" />
              {formatRelative(entry.createdAt)}
            </span>
          </div>

          {entry.note ? (
            <p className="line-clamp-2 text-caption leading-[1.05rem] text-content-tertiary">
              {entry.note}
            </p>
          ) : null}

          <div className="mt-auto flex items-center gap-1.5 pt-1">
            <Button
              variant="secondary"
              size="sm"
              className="min-w-0 flex-1"
              icon={<Sparkles className="size-3.5" />}
              onClick={() => sendToComposer(entry.url)}
            >
              解析并下载
            </Button>

            <Tooltip label="复制链接">
              <IconButton label="复制链接" onClick={() => void copyLink(entry.url)}>
                <Copy className="size-4" />
              </IconButton>
            </Tooltip>

            <Tooltip label="在浏览器中打开">
              <IconButton
                label="在浏览器中打开"
                onClick={() => {
                  void openUrl(entry.url).catch((error: unknown) =>
                    toast.error(
                      "无法打开浏览器",
                      error instanceof Error ? error.message : String(error),
                    ),
                  );
                }}
              >
                <ExternalLink className="size-4" />
              </IconButton>
            </Tooltip>

            <Tooltip label={starred ? "取消收藏" : "重新收藏"}>
              <IconButton
                label={starred ? "取消收藏" : "重新收藏"}
                active={starred}
                onClick={toggleStar}
              >
                {starred ? <Star className="size-4 fill-current" /> : <StarOff className="size-4" />}
              </IconButton>
            </Tooltip>
          </div>
        </div>
      </article>
    </motion.li>
  );
}

/** Loading placeholder shaped like a favourite card. */
function FavoritesSkeleton() {
  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
      aria-hidden
    >
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="panel overflow-hidden">
          <Skeleton className="aspect-video w-full rounded-none" />
          <div className="flex flex-col gap-2 p-3">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
