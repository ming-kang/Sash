import { store, type ToastItem } from "./state.js";

let toastSequence = 0;
interface ToastTimer {
  timer: ReturnType<typeof setTimeout> | null;
  remaining: number;
  startedAt: number;
  pauses: Set<"pointer" | "focus">;
}
const timers = new Map<number, ToastTimer>();

export function pushToast(kind: ToastItem["kind"], text: string): void {
  const id = ++toastSequence;
  store.toasts = [...store.toasts, { id, kind, text }];
  if (kind !== "error") {
    timers.set(id, {
      timer: setTimeout(() => dismissToast(id), 4200),
      remaining: 4200,
      startedAt: Date.now(),
      pauses: new Set(),
    });
  }
}

export function setToastPaused(id: number, reason: "pointer" | "focus", paused: boolean): void {
  const entry = timers.get(id);
  if (!entry) return;
  if (paused) entry.pauses.add(reason);
  else entry.pauses.delete(reason);
  if (entry.pauses.size > 0 && entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.startedAt));
  } else if (entry.pauses.size === 0 && entry.timer === null) {
    entry.startedAt = Date.now();
    entry.timer = setTimeout(() => dismissToast(id), entry.remaining);
  }
}

export function dismissToast(id: number): void {
  const timer = timers.get(id)?.timer;
  if (timer !== undefined && timer !== null) clearTimeout(timer);
  timers.delete(id);
  store.toasts = store.toasts.filter((item) => item.id !== id);
}

export const toast = {
  success: (text: string) => pushToast("success", text),
  error: (text: string) => pushToast("error", text),
  info: (text: string) => pushToast("info", text),
};
