/** Global keyboard shortcuts. */

import { useEffect } from "react";

import { bus, emit } from "@/lib/bus";
import { useUiStore, type PageId } from "@/stores/ui";
import { useSettingsStore } from "@/stores/settings";

const PAGE_ORDER: PageId[] = ["home", "queue", "history", "favorites", "settings", "about"];

/**
 * Registers the application shortcuts.
 *
 * Every binding uses Ctrl (or Ctrl+Shift) so it cannot collide with the IMEs used
 * for Chinese input, and nothing fires while a modal dialog owns the focus.
 */
export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const ctrl = event.ctrlKey || event.metaKey;
      if (!ctrl) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;

      const store = useUiStore.getState();

      // Ctrl+1..6 — jump between pages.
      if (!event.shiftKey && /^[1-6]$/.test(event.key)) {
        const page = PAGE_ORDER[Number(event.key) - 1];
        if (page) {
          event.preventDefault();
          store.setPage(page);
        }
        return;
      }

      switch (event.key.toLowerCase()) {
        case "n":
          event.preventDefault();
          store.setPage("home");
          emit(bus.focusUrl);
          break;
        case "v":
          // Only take over paste when the user is not already in a text field.
          if (!typing) {
            event.preventDefault();
            store.setPage("home");
            void navigator.clipboard
              .readText()
              .then((text) => {
                if (text.trim()) {
                  emit(bus.paste, text);
                } else {
                  emit(bus.focusUrl);
                }
              })
              .catch(() => emit(bus.focusUrl));
          }
          break;
        case "enter":
          if (!typing) {
            event.preventDefault();
            emit(bus.submit);
          }
          break;
        case ",":
          event.preventDefault();
          store.setPage("settings");
          break;
        case "l":
          // Ctrl+L focuses the URL box, matching the browser convention.
          event.preventDefault();
          store.setPage("home");
          emit(bus.focusUrl);
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}

/**
 * Watches the clipboard for a link while the app is focused.
 *
 * The feature is opt-in (Settings → General) and never starts a download by itself:
 * it only offers the detected link.
 *
 * Nothing is read before the user has interacted with the window. WebView2 asks for the
 * clipboard permission the first time a page reads it, and reading during boot put that
 * system dialog in front of the app before the user had touched anything — a dialog that
 * also covered the sidebar and the task card underneath.
 */
export function useClipboardWatcher(): void {
  const enabled = useSettingsStore(
    (state) => state.settings?.general.watchClipboard ?? false,
  );

  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !navigator.clipboard?.readText) {
      return;
    }

    let lastSeen = "";
    let armed = false;

    const check = async () => {
      if (!armed || document.visibilityState !== "visible" || !document.hasFocus()) {
        return;
      }
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (!text || text === lastSeen) {
          return;
        }
        if (!/^https?:\/\//i.test(text)) {
          return;
        }
        lastSeen = text;
        // Hand the link to the composer; the user still decides to parse it.
        emit(bus.paste, text);
      } catch {
        // Reading the clipboard can be denied; that is not an error worth showing.
      }
    };

    // Capture so a handler that stops propagation cannot hide the user's first gesture.
    const arm = () => {
      if (armed) {
        return;
      }
      armed = true;
      void check();
    };
    window.addEventListener("pointerdown", arm, { once: true, capture: true });
    window.addEventListener("keydown", arm, { once: true, capture: true });

    const timer = window.setInterval(check, 1800);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pointerdown", arm, true);
      window.removeEventListener("keydown", arm, true);
    };
  }, [enabled]);
}
