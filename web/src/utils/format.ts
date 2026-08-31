export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  const value = bytes / k ** i;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatDuration(startIso: string | undefined, locale: string): string {
  if (!startIso) return "-";
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return "-";
  let secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const days = Math.floor(secs / 86400);
  secs %= 86400;
  const hours = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (locale === "zh") {
    if (days > 0) return `${days} 天 ${hours} 小时`;
    if (hours > 0) return `${hours} 小时 ${mins} 分`;
    if (mins > 0) return `${mins} 分钟`;
    return `${Math.max(secs % 60, 0)} 秒`;
  }
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return `${Math.max(secs % 60, 0)}s`;
}

export function formatTime(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** Delay in ms → semantic level used for colors. 0/undefined handled by caller. */
export function delayLevel(delay: number): "good" | "mid" | "bad" {
  if (delay <= 0) return "bad";
  if (delay < 300) return "good";
  if (delay < 800) return "mid";
  return "bad";
}
