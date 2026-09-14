/**
 * Custom window chrome.
 *
 * The app draws its own title bar so it matches the design system; the native one is
 * only used when the user turns it back on in Settings → Appearance.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { motion } from "framer-motion";
import { Minus, Moon, Settings2, Square, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";

import { IconButton } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/Surface";
import { Tooltip } from "@/components/ui/Overlay";
import { isDesktop } from "@/api/client";
import { cn } from "@/lib/cn";
import { duration, ease } from "@/lib/motion";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const settings = useSettingsStore((state) => state.settings);
  const patch = useSettingsStore((state) => state.patch);
  const setPage = useUiStore((state) => state.setPage);
  const page = useUiStore((state) => state.page);

  const nativeDecorations = settings?.appearance.nativeDecorations ?? false;
  const theme = settings?.appearance.theme ?? "dark";

  useEffect(() => {
    if (!isDesktop()) {
      return;
    }
    const window = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    void window.isMaximized().then(setMaximized);
    void window
      .onResized(() => {
        void window.isMaximized().then(setMaximized);
      })
      .then((dispose) => {
        unlisten = dispose;
      });

    return () => unlisten?.();
  }, []);

  const cycleTheme = () => {
    const next = theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
    void patch({ appearance: { ...settings!.appearance, theme: next } }, { quiet: true });
  };

  const control = async (action: "minimize" | "toggle" | "close") => {
    if (!isDesktop()) {
      return;
    }
    const window = getCurrentWindow();
    if (action === "minimize") {
      await window.minimize();
    } else if (action === "toggle") {
      await window.toggleMaximize();
    } else {
      await window.close();
    }
  };

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "relative z-30 flex h-11 shrink-0 items-center gap-3 border-b border-line px-3",
        "glass drag-region",
      )}
    >
      <div className="flex items-center gap-2.5 pl-1" data-tauri-drag-region>
        <img src="/icon.png" alt="" className="size-5 rounded-[6px]" />
        <span className="text-label font-semibold tracking-[-0.01em] text-content">
          YT Downloader
        </span>
        <RuntimePill />
      </div>

      <div className="flex-1" data-tauri-drag-region />

      <div className="no-drag flex items-center gap-1">
        <Tooltip label={theme === "dark" ? "切换为浅色" : theme === "light" ? "跟随系统" : "切换为深色"}>
          <IconButton label="切换主题" onClick={cycleTheme}>
            <motion.span
              key={theme}
              initial={{ opacity: 0, rotate: -35, scale: 0.8 }}
              animate={{ opacity: 1, rotate: 0, scale: 1 }}
              transition={{ duration: duration.normal, ease: ease.out }}
              className="inline-flex"
            >
              {theme === "dark" ? (
                <Moon className="size-4" />
              ) : theme === "light" ? (
                <Sun className="size-4" />
              ) : (
                <Sun className="size-4" />
              )}
            </motion.span>
          </IconButton>
        </Tooltip>

        <Tooltip label="设置">
          <IconButton
            label="打开设置"
            active={page === "settings"}
            onClick={() => setPage("settings")}
          >
            <Settings2 className="size-4" />
          </IconButton>
        </Tooltip>

        {nativeDecorations ? null : (
          <>
            <div className="mx-1 h-4 w-px bg-line" />
            <IconButton label="最小化" onClick={() => void control("minimize")}>
              <Minus className="size-4" />
            </IconButton>
            <IconButton
              label={maximized ? "还原" : "最大化"}
              onClick={() => void control("toggle")}
            >
              {maximized ? (
                <span className="relative inline-flex size-4 items-center justify-center">
                  <Square className="absolute size-3 translate-x-[1.5px] translate-y-[-1.5px]" />
                  <Square className="absolute size-3 translate-x-[-1.5px] translate-y-[1.5px]" />
                </span>
              ) : (
                <Square className="size-3.5" />
              )}
            </IconButton>
            <IconButton
              label="关闭"
              onClick={() => void control("close")}
              className="hover:bg-danger-soft hover:text-danger"
            >
              <X className="size-4" />
            </IconButton>
          </>
        )}
      </div>
    </header>
  );
}

/** Small runtime health indicator, always visible in the title bar. */
function RuntimePill() {
  const runtime = useSettingsStore((state) => state.runtime);
  const setPage = useUiStore((state) => state.setPage);

  if (!runtime) {
    return null;
  }

  const tone = runtime.complete ? "success" : "warning";
  const label = runtime.complete
    ? `yt-dlp ${runtime.ytDlp.version ?? ""} · FFmpeg ${runtime.ffmpeg.version ?? ""}`
    : "运行库不完整，点击查看";

  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={() => setPage("about")}
        className="no-drag flex items-center gap-1.5 rounded-full border border-line bg-surface-muted px-2 py-[3px] text-micro text-content-tertiary transition-colors hover:text-content-secondary"
      >
        <StatusDot tone={tone} pulse={!runtime.complete} />
        {runtime.complete ? "运行库就绪" : "运行库异常"}
      </button>
    </Tooltip>
  );
}
