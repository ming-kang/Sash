import type { Ref } from "vue";
import { createI18n } from "vue-i18n";
import { en } from "./en.js";
import { zh } from "./zh.js";

export type Locale = "zh" | "en";

const STORAGE_KEY = "sash.locale";

const hasDOM = typeof window !== "undefined" && typeof document !== "undefined";

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "zh") return saved;
  } catch {}
  return "zh";
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: "zh",
  missingWarn: false,
  fallbackWarn: false,
  messages: { zh, en },
});

export const locale = i18n.global.locale as unknown as Ref<Locale>;

export function setLocale(next: Locale): void {
  locale.value = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {}
  if (hasDOM) {
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  }
}

if (hasDOM) {
  document.documentElement.lang = locale.value === "zh" ? "zh-CN" : "en";
}

// Single-brace `{name}` interpolation is vue-i18n's default format, so the
// existing dictionaries and all `t(path, params)` call sites keep working.
export function t(path: string, params?: Record<string, string | number>): string {
  return params === undefined
    ? i18n.global.t(path)
    : i18n.global.t(path, params as Record<string, unknown>);
}
