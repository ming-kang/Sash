import { store, type ToastItem } from "./state.js";

/** Errors stay until dismissed; everything else auto-dismisses. */
const TOAST_DURATION: Record<ToastItem["kind"], number> = {
  success: 3600,
  info: 4200,
  warning: 6500,
  error: 0,
};
/** Beyond this the oldest dismissible toast leaves; a wall of text helps nobody. */
const MAX_TOASTS = 5;

let toastSequence = 0;
interface ToastTimer {
  timer: ReturnType<typeof setTimeout> | null;
  remaining: number;
  startedAt: number;
  pauses: Set<"pointer" | "focus">;
}
const timers = new Map<number, ToastTimer>();

function armTimer(id: number, delay: number): void {
  const entry = timers.get(id);
  if (!entry) return;
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.remaining = delay;
  entry.startedAt = Date.now();
  entry.timer = entry.pauses.size > 0 ? null : setTimeout(() => dismissToast(id), delay);
}

export function pushToast(kind: ToastItem["kind"], text: string): void {
  const duration = TOAST_DURATION[kind];
  // An identical visible toast folds into a repeat counter instead of stacking.
  const duplicate = store.toasts.find((item) => item.kind === kind && item.text === text);
  if (duplicate) {
    store.toasts = [
      ...store.toasts.filter((item) => item.id !== duplicate.id),
      { ...duplicate, count: duplicate.count + 1 },
    ];
    if (duration > 0) armTimer(duplicate.id, duration);
    return;
  }
  const id = ++toastSequence;
  store.toasts = [...store.toasts, { id, kind, text, count: 1, duration }];
  if (duration > 0) {
    timers.set(id, {
      timer: setTimeout(() => dismissToast(id), duration),
      remaining: duration,
      startedAt: Date.now(),
      pauses: new Set(),
    });
  }
  while (store.toasts.length > MAX_TOASTS) {
    const oldest =
      store.toasts.find((item) => item.duration > 0 && item.id !== id) ??
      store.toasts.find((item) => item.id !== id);
    if (!oldest) break;
    dismissToast(oldest.id);
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
  warning: (text: string) => pushToast("warning", text),
  info: (text: string) => pushToast("info", text),
};
