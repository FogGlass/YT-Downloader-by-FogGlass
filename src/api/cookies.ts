/**
 * Cookie diagnostics.
 *
 * The application never reads cookie *values*; these calls only report whether the
 * browser's cookie store exists, whether it is in use, and whether the browser protects
 * it with app-bound encryption (which makes it unreadable by any third-party tool).
 */

import { call } from "./client";
import type { CookieFileCheck, CookieStatus } from "@/types/models";

/** Inspect the configured browser's cookie store (read-only). */
export const cookieStatus = () => call<CookieStatus>("cookie_status");

/** Validate a cookies.txt path: existence and Netscape header only. */
export const validateCookieFile = (path: string) =>
  call<CookieFileCheck>("validate_cookie_file", { path });
