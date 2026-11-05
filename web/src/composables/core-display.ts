import { computed, ref, watch } from "vue";
import { store } from "../stores/index.js";
import type { SashStatus } from "../types/index.js";
import { normalizeCoreVersion, useCoreControl } from "./core-runtime.js";

/** What the Core panel reports. */
export type CoreDisplayState = "stopping" | "starting" | "unresponsive" | "running" | "stopped";

export function coreDisplayState(input: {
  status: SashStatus | null;
  starting: boolean;
  stopping: boolean;
}): CoreDisplayState {
  if (input.stopping) return "stopping";
  const core = input.status?.core;
  if (!core?.running) return input.starting ? "starting" : "stopped";
  // The supervisor marks Core healthy only after its controller answers a version probe.
  return core.healthy ? "running" : "unresponsive";
}

/**
 * The daemon reports a version only while the controller answers, so the panel keeps the last
 * one it saw. An update replaces the binary, which makes the remembered version meaningless.
 */
export function rememberCoreVersion(previous: string, status: SashStatus | null): string {
  if (!status) return previous;
  if (status.coreUpdate) return "";
  return normalizeCoreVersion(status.core.version) || previous;
}

const lastCoreVersion = ref("");
watch(
  () => store.status,
  (status) => {
    lastCoreVersion.value = rememberCoreVersion(lastCoreVersion.value, status);
  },
  { immediate: true },
);

export function useCoreDisplay() {
  const { restarting, stopping } = useCoreControl();
  const state = computed(() =>
    coreDisplayState({
      status: store.status,
      starting: restarting.value,
      stopping: stopping.value,
    }),
  );
  return { state, version: computed(() => lastCoreVersion.value) };
}
