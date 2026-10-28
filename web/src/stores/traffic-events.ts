import { watch } from "vue";
import { api, sessionReady } from "../api/index.js";
import { resetTraffic } from "./core-actions.js";
import { isCoreReady, store } from "./state.js";
import { addTraffic } from "./telemetry.js";

const STALE_HISTORY_MS = 5000;

export function startTrafficEvents(intervalMs = 100): () => void {
  let unsubscribe: (() => void) | null = null;
  let staleTimer: number | null = null;
  let flushTimer: number | null = null;
  let pending: { message: Parameters<typeof addTraffic>[0]; generation: number } | null = null;

  const clearPending = (): void => {
    pending = null;
    if (flushTimer !== null) window.clearTimeout(flushTimer);
    flushTimer = null;
  };
  const flush = (): void => {
    flushTimer = null;
    const next = pending;
    pending = null;
    if (next) addTraffic(next.message, next.generation);
  };
  const stopStream = (): void => {
    unsubscribe?.();
    unsubscribe = null;
    clearPending();
    if (staleTimer !== null) window.clearTimeout(staleTimer);
    staleTimer = null;
  };

  const stopWatch = watch(
    () =>
      store.daemonOnline && isCoreReady.value && sessionReady.value
        ? store.runtimeGeneration
        : null,
    (generation) => {
      stopStream();
      if (generation === null) {
        resetTraffic();
        return;
      }
      unsubscribe = api.connectTraffic(
        (message) => {
          if (generation !== store.runtimeGeneration) return;
          if (staleTimer !== null) window.clearTimeout(staleTimer);
          staleTimer = null;
          pending = { message, generation };
          if (intervalMs <= 0 || document.hidden) flush();
          else if (flushTimer === null) flushTimer = window.setTimeout(flush, intervalMs);
        },
        () => {
          if (generation !== store.runtimeGeneration || staleTimer !== null) return;
          clearPending();
          // A broken socket is different from a hidden tab: show no stale live rate,
          // but retain the recent curve while the transport reconnects.
          store.traffic = { ...store.traffic, up: 0, down: 0 };
          staleTimer = window.setTimeout(() => {
            staleTimer = null;
            if (generation === store.runtimeGeneration) resetTraffic();
          }, STALE_HISTORY_MS);
        },
      );
    },
    { immediate: true },
  );

  return () => {
    stopWatch();
    stopStream();
  };
}
