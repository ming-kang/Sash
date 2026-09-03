import { store, type ToastItem } from "./state.js";

let toastSequence = 0;

export function pushToast(kind: ToastItem["kind"], text: string): void {
  const id = ++toastSequence;
  store.toasts.push({ id, kind, text });
  window.setTimeout(() => dismissToast(id), 4200);
}

export function dismissToast(id: number): void {
  const index = store.toasts.findIndex((item) => item.id === id);
  if (index >= 0) store.toasts.splice(index, 1);
}

export const toast = {
  success: (text: string) => pushToast("success", text),
  error: (text: string) => pushToast("error", text),
  info: (text: string) => pushToast("info", text),
};
