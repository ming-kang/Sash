import { ref } from "vue";
import { en } from "./en.js";
import { type Messages, zh } from "./zh.js";

export type Locale = "zh" | "en";

const STORAGE_KEY = "sash.locale";

const hasDOM = typeof window !== "undefined" && typeof document !== "undefined";

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "zh") return saved;
  } catch {
    // storage unavailable (private mode etc.)
  }
  return "zh";
}

export const locale = ref<Locale>(detectLocale());

const dicts: Record<Locale, Messages> = { zh, en };

export function setLocale(next: Locale): void {
  locale.value = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore
  }
  if (hasDOM) {
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  }
}

if (hasDOM) {
  document.documentElement.lang = locale.value === "zh" ? "zh-CN" : "en";
}

export function t(path: string, params?: Record<string, string | number>): string {
  let node: unknown = dicts[locale.value];
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object") {
      node = undefined;
      break;
    }
    node = (node as Record<string, unknown>)[key];
  }
  let text = typeof node === "string" ? node : path;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}
