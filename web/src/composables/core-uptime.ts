import { computed, onScopeDispose, ref, watch } from "vue";
import { isCoreRunning, store } from "../stores/index.js";
import { formatUptime } from "../utils/format.js";

export function useCoreUptime() {
  const now = ref(Date.now());
  let clock: ReturnType<typeof setInterval> | undefined;

  function stopClock(): void {
    if (clock !== undefined) clearInterval(clock);
    clock = undefined;
  }

  const stopWatching = watch(
    isCoreRunning,
    (running) => {
      stopClock();
      if (!running) return;
      now.value = Date.now();
      clock = setInterval(() => {
        now.value = Date.now();
      }, 1000);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    stopWatching();
    stopClock();
  });

  return computed(() =>
    isCoreRunning.value ? formatUptime(store.status?.core.startedAt, now.value) : "--:--:--",
  );
}
