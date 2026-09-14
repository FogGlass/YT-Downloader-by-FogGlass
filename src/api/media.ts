/** Media probing and URL validation. */

import { call } from "./client";
import type { MediaProbe, UrlCheck } from "@/types/models";

/** Split pasted text into validated URLs, de-duplicated by the backend. */
export const validateUrls = (text: string) =>
  call<UrlCheck[]>("validate_urls", { text });

/** Resolve a video, playlist or channel without downloading anything. */
export const probeUrl = (url: string, playlist?: boolean, ignoreCookies?: boolean) =>
  call<MediaProbe>("probe_url", {
    url,
    playlist: playlist ?? null,
    ignoreCookies: ignoreCookies ?? null,
  });

/**
 * Resolve a whole playlist/channel, optionally capped.
 *
 * `ignoreCookies` re-runs the parse without browser cookies — the fallback used when the
 * browser's cookie store cannot be read or decrypted.
 */
export const probePlaylist = (url: string, limit?: number, ignoreCookies?: boolean) =>
  call<MediaProbe>("probe_playlist", {
    url,
    limit: limit ?? null,
    ignoreCookies: ignoreCookies ?? null,
  });

/** Stop a running probe. Returns true when a probe process was signalled. */
export const cancelProbe = () => call<boolean>("cancel_probe");

export const supportedLinkExamples = () =>
  call<string[]>("supported_link_examples");

export const dataRoot = () => call<string>("data_root");
