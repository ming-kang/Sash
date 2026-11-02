import { t } from "../i18n/index.js";

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

export function formatDuration(startIso: string | undefined): string {
  if (!startIso) return "-";
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return "-";
  let secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const days = Math.floor(secs / 86400);
  secs %= 86400;
  const hours = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (days > 0) return t("format.durationDayHour", { d: days, h: hours });
  if (hours > 0) return t("format.durationHourMin", { h: hours, m: mins });
  if (mins > 0) return t("format.durationMin", { m: mins });
  return t("format.durationSec", { s: Math.max(secs % 60, 0) });
}

export function formatTime(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

export function formatAgo(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  const mins = Math.floor(Math.max(0, Date.now() - ms) / 60000);
  if (mins < 1) return t("format.justNow");
  if (mins < 60) return t("format.minutesAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("format.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("format.daysAgo", { n: days });
  const months = Math.floor(days / 30);
  if (months < 12) return t("format.monthsAgo", { n: months });
  const years = Math.floor(months / 12);
  return t("format.yearsAgo", { n: years });
}

export function formatDate(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const LEADING_FLAG = /^\s*([\u{1F1E6}-\u{1F1FF}]{2})\s*/u;

/**
 * Splits a leading flag emoji into its region code. Windows Chromium has no flag glyphs and
 * draws bare letters, so cards render the code themselves for the same look in every engine.
 */
export function splitRegionFlag(name: string): { region: string; label: string } {
  const match = LEADING_FLAG.exec(name);
  const label = match ? name.slice(match[0].length) : "";
  if (!match?.[1] || !label) return { region: "", label: name };
  const region = Array.from(match[1], (symbol) =>
    String.fromCharCode((symbol.codePointAt(0) ?? 0x1f1e6) - 0x1f1e6 + 65),
  ).join("");
  return { region, label };
}

export function delayLevel(delay: number): "good" | "mid" | "bad" {
  if (delay <= 0) return "bad";
  if (delay < 300) return "good";
  if (delay < 800) return "mid";
  return "bad";
}
