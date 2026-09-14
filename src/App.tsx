/** Application root: boots the stores, wires events and renders the shell. */

import { useEffect } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { useEventBridge } from "@/hooks/useEventBridge";
import { useClipboardWatcher, useKeyboardShortcuts } from "@/hooks/useShortcuts";
import { AboutPage } from "@/pages/AboutPage";
import { FavoritesPage } from "@/pages/FavoritesPage";
import { HistoryPage } from "@/pages/HistoryPage";
import { HomePage } from "@/pages/HomePage";
import { QueuePage } from "@/pages/QueuePage";
import { SettingsPage } from "@/pages/SettingsPage";
import { useLibraryStore } from "@/stores/library";
import { useSettingsStore, watchSystemTheme } from "@/stores/settings";
import { useTasksStore } from "@/stores/tasks";
import { useUiStore } from "@/stores/ui";

export function App() {
  const loadSettings = useSettingsStore((state) => state.load);
  const loadTasks = useTasksStore((state) => state.load);
  const loadLibrary = useLibraryStore((state) => state.load);
  const setPage = useUiStore((state) => state.setPage);
  const settings = useSettingsStore((state) => state.settings);

  useEventBridge();
  useKeyboardShortcuts();
  useClipboardWatcher();

  useEffect(() => {
    void loadSettings();
    void loadTasks();
    void loadLibrary();
  }, [loadSettings, loadTasks, loadLibrary]);

  useEffect(() => watchSystemTheme(), []);

  // Restore the last visited page once the settings are known.
  useEffect(() => {
    if (!settings) {
      return;
    }
    if (settings.general.restoreLastPage && settings.general.lastPage) {
      const restored = settings.general.lastPage as Parameters<typeof setPage>[0];
      if (["home", "queue", "history", "favorites", "settings", "about"].includes(restored)) {
        setPage(restored);
      }
    }
    // Deliberately runs once when settings first arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings !== null]);

  return (
    <AppShell
      pages={{
        home: <HomePage />,
        queue: <QueuePage />,
        history: <HistoryPage />,
        favorites: <FavoritesPage />,
        settings: <SettingsPage />,
        about: <AboutPage />,
      }}
    />
  );
}
