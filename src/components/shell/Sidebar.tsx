/**
 * The sidebar.
 *
 * The active item is marked by a single shared element that springs between rows, so
 * navigation reads as one continuous movement rather than two independent states.
 */

import { motion, useReducedMotion } from "framer-motion";
import {
  Clock3,
  Download,
  House,
  Info,
  Plus,
  Settings2,
  Star,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button, IconButton } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/Surface";
import { Tooltip } from "@/components/ui/Overlay";
import { cn } from "@/lib/cn";
import { bus, emit } from "@/lib/bus";
import { duration, ease, spring } from "@/lib/motion";
import { useSettingsStore } from "@/stores/settings";
import { useQueueCounts } from "@/stores/tasks";
import { PAGES, useUiStore, type PageId } from "@/stores/ui";

const ICONS: Record<PageId, LucideIcon> = {
  home: House,
  queue: Download,
  history: Clock3,
  favorites: Star,
  settings: Settings2,
  about: Info,
};

const PRIMARY: PageId[] = ["home", "queue", "history", "favorites"];
const SECONDARY: PageId[] = ["settings", "about"];

export function Sidebar() {
  const page = useUiStore((state) => state.page);
  const setPage = useUiStore((state) => state.setPage);
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const counts = useQueueCounts();
  const runtime = useSettingsStore((state) => state.runtime);
  const info = useSettingsStore((state) => state.info);
  const showLabels = useSettingsStore(
    (state) => state.settings?.appearance.showSidebarLabels ?? true,
  );
  const reduce = useReducedMotion();

  const labelsVisible = showLabels && !collapsed;

  const badgeFor = (id: PageId): string | undefined => {
    if (id !== "queue") {
      return undefined;
    }
    if (counts.active > 0) {
      return String(counts.active);
    }
    if (counts.queued > 0) {
      return String(counts.queued);
    }
    return undefined;
  };

  const startNew = () => {
    setPage("home");
    emitFocus();
  };

  return (
    <motion.aside
      layout
      transition={reduce ? { duration: 0 } : spring}
      className={cn(
        "relative z-20 flex shrink-0 flex-col gap-1 border-r border-line bg-surface-muted/60 p-2.5",
        labelsVisible ? "w-[13.75rem]" : "w-[4.25rem]",
      )}
    >
      <div className="flex items-center gap-2 px-0.5 pt-0.5 pb-2">
        {labelsVisible ? (
          <motion.div
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: duration.normal, ease: ease.out }}
            className="min-w-0 flex-1"
          >
            <p className="truncate text-label font-semibold text-content">工作台</p>
            <p className="truncate text-micro text-content-tertiary">
              yt-dlp + FFmpeg
            </p>
          </motion.div>
        ) : null}
        <Tooltip label={collapsed ? "展开侧边栏" : "收起侧边栏"} side="right">
          <IconButton
            label={collapsed ? "展开侧边栏" : "收起侧边栏"}
            onClick={toggleSidebar}
            className={cn(!labelsVisible && "mx-auto")}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </IconButton>
        </Tooltip>
      </div>

      <div className="px-0.5 pb-2">
        {labelsVisible ? (
          <Button
            variant="primary"
            size="md"
            fullWidth
            icon={<Plus className="size-4" />}
            onClick={startNew}
          >
            新建下载
          </Button>
        ) : (
          <Tooltip label="新建下载" side="right">
            <Button
              variant="primary"
              size="md"
              className="mx-auto !px-0 w-9.5"
              onClick={startNew}
              aria-label="新建下载"
            >
              <Plus className="size-4" />
            </Button>
          </Tooltip>
        )}
      </div>

      <nav className="flex flex-1 flex-col gap-0.5">
        {PRIMARY.map((id) => (
          <NavItem
            key={id}
            id={id}
            active={page === id}
            collapsed={!labelsVisible}
            badge={badgeFor(id)}
            onSelect={() => setPage(id)}
          />
        ))}
      </nav>

      <div className="mt-1 flex flex-col gap-0.5 border-t border-line pt-2">
        {SECONDARY.map((id) => (
          <NavItem
            key={id}
            id={id}
            active={page === id}
            collapsed={!labelsVisible}
            onSelect={() => setPage(id)}
          />
        ))}
      </div>

      <RuntimeFooter collapsed={!labelsVisible} runtime={runtime} version={info?.version} />
    </motion.aside>
  );
}

function NavItem({
  id,
  active,
  collapsed,
  badge,
  onSelect,
}: {
  id: PageId;
  active: boolean;
  collapsed: boolean;
  badge?: string;
  onSelect: () => void;
}) {
  const meta = PAGES.find((entry) => entry.id === id)!;
  const Icon = ICONS[id];

  return (
    <Tooltip label={collapsed ? meta.label : ""} side="right">
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group relative flex h-9 items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 text-left text-label font-medium transition-colors",
          collapsed && "justify-center px-0",
          active ? "text-content" : "text-content-secondary hover:text-content",
        )}
      >
        {active ? (
          <motion.span
            layoutId="sidebar-active"
            transition={spring}
            className="absolute inset-0 rounded-[var(--radius-md)] border border-line bg-surface-elevated shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
          />
        ) : (
          <span className="absolute inset-0 rounded-[var(--radius-md)] opacity-0 transition-opacity group-hover:bg-surface-hover group-hover:opacity-100" />
        )}

        <span className="relative z-10 flex items-center gap-2.5">
          <Icon
            className={cn(
              "size-[17px] shrink-0 transition-colors",
              active ? "text-accent" : "text-content-tertiary group-hover:text-content-secondary",
            )}
            strokeWidth={active ? 2.1 : 1.85}
          />
          {collapsed ? null : <span className="truncate">{meta.label}</span>}
        </span>

        {badge ? (
          <motion.span
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={spring}
            className={cn(
              "relative z-10 rounded-full bg-accent-soft px-1.5 text-micro font-semibold tabular-nums text-accent",
              collapsed ? "absolute -top-0.5 right-1.5" : "ml-auto",
            )}
          >
            {badge}
          </motion.span>
        ) : null}
      </button>
    </Tooltip>
  );
}

function RuntimeFooter({
  collapsed,
  runtime,
  version,
}: {
  collapsed: boolean;
  runtime: ReturnType<typeof useSettingsStore.getState>["runtime"];
  version?: string;
}) {
  const setPage = useUiStore((state) => state.setPage);
  const tone = runtime?.complete ? "success" : runtime ? "warning" : "neutral";

  return (
    <button
      type="button"
      onClick={() => setPage("about")}
      className={cn(
        "mt-1 flex items-center gap-2 rounded-[var(--radius-md)] border border-line-subtle bg-surface-muted px-2.5 py-2 text-left transition-colors hover:bg-surface-hover",
        collapsed && "justify-center px-0",
      )}
    >
      <StatusDot tone={tone} pulse={!runtime?.complete} />
      {collapsed ? null : (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-micro font-medium text-content-secondary">
            {runtime?.complete ? "运行库就绪" : runtime ? "运行库需要检查" : "正在检测"}
          </span>
          <span className="block truncate text-micro text-content-tertiary">
            v{version ?? "1.0.0"}
          </span>
        </span>
      )}
    </button>
  );
}

function emitFocus() {
  emit(bus.focusUrl);
}
