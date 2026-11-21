import { computed } from "vue";
import { store } from "../stores/index.js";
import type { SashStatus } from "../types/index.js";
import { useCoreControl } from "./core-runtime.js";

export type CoreDisplayState = "stopping" | "starting" | "unresponsive" | "running" | "stopped";

export function coreDisplayState(input: {
  status: SashStatus | null;
  starting: boolean;
  stopping: boolean;
}): CoreDisplayState {
  if (input.stopping) return "stopping";
  const core = input.status?.core;
  if (!core?.running) return input.starting ? "starting" : "stopped";
  return core.healthy ? "running" : "unresponsive";
}

export function useCoreDisplay() {
  const { restarting, stopping } = useCoreControl();
  const state = computed(() =>
    coreDisplayState({
      status: store.status,
      starting: restarting.value,
      stopping: stopping.value,
    }),
  );
  return { state };
}
