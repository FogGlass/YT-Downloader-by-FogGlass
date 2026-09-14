/** The application frame: title bar, sidebar and the animated page area. */

import { AnimatePresence, motion } from "framer-motion";
import type { ReactNode } from "react";

import { Sidebar } from "@/components/shell/Sidebar";
import { TitleBar } from "@/components/shell/TitleBar";
import { ConfirmHost, TooltipProvider } from "@/components/ui/Overlay";
import { ToastHost } from "@/components/ui/Feedback";
import { cn } from "@/lib/cn";
import { pageVariants } from "@/lib/motion";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore, type PageId } from "@/stores/ui";

export function AppShell({
  pages,
}: {
  pages: Record<PageId, ReactNode>;
}) {
  const page = useUiStore((state) => state.page);
  const ambient = useSettingsStore(
    (state) => state.settings?.appearance.ambientBackground ?? true,
  );

  return (
    <TooltipProvider>
      <div className="relative flex h-full w-full flex-col overflow-hidden bg-background">
        <TitleBar />

        <div className="relative flex min-h-0 flex-1">
          <Sidebar />

          <main className="relative min-w-0 flex-1 overflow-hidden">
            {/* Ambient motion: two very slow radial gradients. GPU-only, and off
                when the user disables it or the OS asks for reduced motion. */}
            {ambient ? <div className="ambient" aria-hidden /> : null}

            <div className={cn("relative z-10 h-full overflow-y-auto")}>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={page}
                  variants={pageVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="mx-auto flex h-full w-full max-w-[92rem] flex-col px-6 py-5"
                >
                  {pages[page]}
                </motion.div>
              </AnimatePresence>
            </div>
          </main>
        </div>

        <ToastHost />
        <ConfirmHost />
      </div>
    </TooltipProvider>
  );
}
