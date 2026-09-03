import { computed, ref } from "vue";

export type Theme = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<Theme, "system">;

const STORAGE_KEY = "sash.theme";
const hasDOM = typeof window !== "undefined" && typeof document !== "undefined";
const mediaQuery = hasDOM ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function readTheme(): Theme {
  if (!hasDOM) return "system";
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "system" || saved === "light" || saved === "dark") return saved;
  } catch {
    // Storage can be unavailable in private or restricted browsing contexts.
  }
  return "system";
}

export const theme = ref<Theme>(readTheme());
const systemTheme = ref<ResolvedTheme>(mediaQuery?.matches ? "dark" : "light");
const resolvedTheme = computed<ResolvedTheme>(() =>
  theme.value === "system" ? systemTheme.value : theme.value,
);

export function isDarkTheme(): boolean {
  return resolvedTheme.value === "dark";
}

function applyTheme(): void {
  if (!hasDOM) return;
  document.documentElement.dataset.theme = resolvedTheme.value;
  document.documentElement.style.colorScheme = resolvedTheme.value;
}

export function setTheme(next: Theme): void {
  theme.value = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Keep the in-memory preference when persistence is unavailable.
  }
  applyTheme();
}

export function cycleTheme(): void {
  const themes: Theme[] = ["system", "light", "dark"];
  setTheme(themes[(themes.indexOf(theme.value) + 1) % themes.length] ?? "system");
}

if (mediaQuery) {
  mediaQuery.addEventListener("change", (event) => {
    systemTheme.value = event.matches ? "dark" : "light";
    if (theme.value === "system") applyTheme();
  });
}

applyTheme();
