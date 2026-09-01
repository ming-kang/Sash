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

/** ISO timestamp → compact relative age ("12 min ago" / "12 分钟前"). */
export function formatAgo(iso: string, locale: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  const mins = Math.floor(Math.max(0, Date.now() - ms) / 60000);
  const zh = locale === "zh";
  if (mins < 1) return zh ? "刚刚" : "just now";
  if (mins < 60) return zh ? `${mins} 分钟前` : `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return zh ? `${days} 天前` : `${days} d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return zh ? `${months} 个月前` : `${months} mo ago`;
  const years = Math.floor(months / 12);
  return zh ? `${years} 年前` : `${years} y ago`;
}

/** Unix epoch seconds → yyyy-mm-dd. */
export function formatDate(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Delay in ms → semantic level used for colors. 0/undefined handled by caller. */
export function delayLevel(delay: number): "good" | "mid" | "bad" {
  if (delay <= 0) return "bad";
  if (delay < 300) return "good";
  if (delay < 800) return "mid";
  return "bad";
}
