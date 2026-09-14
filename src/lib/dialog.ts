/** Native dialogs, wrapped so call sites never import the plugin directly. */

import { open } from "@tauri-apps/plugin-dialog";

import { isDesktop } from "@/api/client";

/** Pick a folder. Returns null when the user cancels or running in a browser. */
export async function pickDirectory(title = "选择下载目录"): Promise<string | null> {
  if (!isDesktop()) {
    return null;
  }
  const selected = await open({ directory: true, multiple: false, title });
  return typeof selected === "string" ? selected : null;
}

/** Pick a single file (used for cookies.txt). */
export async function pickFile(
  title = "选择文件",
  filters?: { name: string; extensions: string[] }[],
): Promise<string | null> {
  if (!isDesktop()) {
    return null;
  }
  const selected = await open({
    directory: false,
    multiple: false,
    title,
    filters: filters ?? [{ name: "所有文件", extensions: ["*"] }],
  });
  return typeof selected === "string" ? selected : null;
}
