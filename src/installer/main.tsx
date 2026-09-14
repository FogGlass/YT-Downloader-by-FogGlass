/**
 * The installer window's entry point.
 *
 * A separate HTML entry from the main app because the setup window is its own Tauri
 * window with its own command surface — but it mounts the same design system, so the
 * installer is visually the same product.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/styles/theme.css";
import { InstallerApp } from "./InstallerApp";

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到 #root 挂载点");
}

createRoot(container).render(
  <StrictMode>
    <InstallerApp />
  </StrictMode>,
);
