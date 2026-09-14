/** Presentation helpers. All of these are pure so they can be unit tested. */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** "1.24 GB" — binary units, two significant decimals. */
export function formatBytes(bytes: number | null | undefined, decimals = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes === 0) {
    return "0 B";
  }
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    UNITS.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  const digits = value >= 100 || exponent === 0 ? 0 : decimals;
  return `${value.toFixed(digits)} ${UNITS[exponent]}`;
}

/** "8.4 MB/s" */
export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return "—";
  }
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** "1:02:03" / "12:34" */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${minutes}:${pad(secs)}`;
}

/** "还剩 2 分 10 秒" */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  const total = Math.round(seconds);
  if (total < 60) {
    return `${total} 秒`;
  }
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes < 60) {
    return secs > 0 ? `${minutes} 分 ${secs} 秒` : `${minutes} 分`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

export function formatPercent(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "0%";
  }
  const percent = Math.max(0, Math.min(1, value)) * 100;
  // Whole numbers read better while downloading; keep one decimal near the end.
  return percent >= 99.95 || percent === 0
    ? `${Math.round(percent)}%`
    : `${percent.toFixed(decimals)}%`;
}

/** "1.2 万次观看" style compact numbers. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  if (value >= 100_000_000) {
    return `${(value / 100_000_000).toFixed(1)} 亿`;
  }
  if (value >= 10_000) {
    return `${(value / 10_000).toFixed(1)} 万`;
  }
  return value.toLocaleString("zh-CN");
}

/** yt-dlp upload dates arrive as YYYYMMDD. */
export function formatUploadDate(raw: string | null | undefined): string {
  if (!raw || raw.length !== 8) {
    return "—";
  }
  const year = raw.slice(0, 4);
  const month = raw.slice(4, 6);
  const day = raw.slice(6, 8);
  return `${year}-${month}-${day}`;
}

/** "刚刚" / "3 分钟前" / "2026-09-13 12:04" */
export function formatRelative(timestamp: string): string {
  const parsed = Date.parse(timestamp.replace(" ", "T"));
  if (Number.isNaN(parsed)) {
    return timestamp;
  }
  const diff = Date.now() - parsed;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) {
    return "刚刚";
  }
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days} 天前`;
  }
  return timestamp.slice(0, 16);
}

/** Trim a long path for display, keeping the file name and the tail of the folder. */
export function shortenPath(path: string, maxLength = 58): string {
  if (path.length <= maxLength) {
    return path;
  }
  const parts = path.split(/[\\/]/);
  const file = parts.at(-1) ?? path;
  const head = parts.slice(0, -1).join("\\");
  const room = maxLength - file.length - 4;
  if (room <= 6) {
    return `…\\${file}`;
  }
  return `${head.slice(0, room)}…\\${file}`;
}

/** Video container → a short badge label. */
export function containerLabel(container: string | null | undefined): string {
  if (!container) {
    return "—";
  }
  const lowered = container.toLowerCase();
  if (lowered === "matroska") {
    return "MKV";
  }
  if (lowered === "m4a") {
    return "M4A";
  }
  return lowered.toUpperCase();
}
