import { watch } from "vue";
import { api, sessionReady } from "../api/index.js";
import { resetTraffic } from "./core-actions.js";
import { isCoreReady, store } from "./state.js";
import { addTraffic } from "./telemetry.js";

const STALE_HISTORY_MS = 5000;

/** Traffic belongs to the Core runtime, not to a visible route or browser tab. */
export function startTrafficEvents(): () => void {
  let unsubscribe: (() => void) | null = null;
  let staleTimer: number | null = null;

  const stopStream = (): void => {
    unsubscribe?.();
    unsubscribe = null;
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
          addTraffic(message, generation);
        },
        () => {
          if (generation !== store.runtimeGeneration || staleTimer !== null) return;
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
