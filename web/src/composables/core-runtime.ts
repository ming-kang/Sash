import { computed, ref } from "vue";
import { api } from "../api/index.js";
import { confirmDialog } from "../components/confirm.js";
import { t } from "../i18n/index.js";
import { errorText, isConnected, refreshRuntimeState, store, toast } from "../stores/index.js";

export function normalizeCoreVersion(version: string | undefined): string {
  return version ? (version.startsWith("v") ? version : `v${version}`) : "";
}

export const coreVersion = computed(() => normalizeCoreVersion(store.status?.core.version));

export const applyPending = computed(() =>
  Boolean(isConnected.value && store.status?.core.running && store.status.configuration.pending),
);

export const coreUpdateText = computed(() => {
  const update = store.status?.coreUpdate;
  if (!update) return "";
  const stage = t(`coreUpdate.${update.stage}`);
  const target = update.target ? ` (${update.target})` : "";
  const bytes = update.downloading
    ? `: ${(update.downloaded / 1048576).toFixed(1)}${update.total ? ` / ${(update.total / 1048576).toFixed(1)}` : ""} MiB`
    : "";
  const note = update.note ? ` · ${update.note}` : "";
  return `${stage}${target}${bytes}${note}`;
});
const restarting = ref(false);
const stopping = ref(false);
const cancellingUpdate = ref(false);
let actionGeneration = 0;

async function cancelCoreUpdate(): Promise<void> {
  if (cancellingUpdate.value) return;
  cancellingUpdate.value = true;
  const generation = ++actionGeneration;
  try {
    await api.cancelCoreUpdate();
    await refreshRuntimeState();
  } catch (error) {
    if (generation === actionGeneration) toast.error(t("toast.failed", { msg: errorText(error) }));
  } finally {
    cancellingUpdate.value = false;
  }
}

export interface CoreUpdateCheckState {
  status: "idle" | "checking" | "current" | "available" | "error";
  target: string | null;
  error: string | null;
}
export const coreUpdateCheck = ref<CoreUpdateCheckState>({
  status: "idle",
  target: null,
  error: null,
});
export const updatingCore = ref(false);
let checkGeneration = 0;

export async function refreshCoreUpdateCheck(): Promise<void> {
  const generation = ++checkGeneration;
  coreUpdateCheck.value = { status: "checking", target: null, error: null };
  try {
    const result = await api.checkCoreUpdate();
    if (generation !== checkGeneration) return;
    coreUpdateCheck.value = {
      status: result.available ? "available" : "current",
      target: result.target,
      error: null,
    };
  } catch (error) {
    if (generation !== checkGeneration) return;
    coreUpdateCheck.value = { status: "error", target: null, error: errorText(error) };
  }
}

export async function startCoreUpdate(): Promise<void> {
  if (updatingCore.value) return;
  updatingCore.value = true;
  const generation = ++actionGeneration;
  try {
    const result = await api.updateCore();
    await refreshRuntimeState();
    if (generation !== actionGeneration) return;
    coreUpdateCheck.value = { status: "current", target: result.version, error: null };
    if (!result.alreadyCurrent)
      toast.success(t("toast.coreUpdated", { v: normalizeCoreVersion(result.version) }));
  } catch (error) {
    if (generation === actionGeneration) toast.error(t("toast.failed", { msg: errorText(error) }));
  } finally {
    updatingCore.value = false;
  }
}

export function useCoreControl() {
  async function restartCore(): Promise<void> {
    if (restarting.value || stopping.value || !store.status) return;
    restarting.value = true;
    const generation = ++actionGeneration;
    const reapplying = store.status.core.running;
    try {
      await api.restartCore();
      await refreshRuntimeState();
      if (reapplying && generation === actionGeneration) toast.success(t("toast.coreRestarted"));
    } catch (error) {
      await refreshRuntimeState().catch(() => undefined);
      if (generation === actionGeneration)
        toast.error(t("toast.failed", { msg: errorText(error) }));
    } finally {
      restarting.value = false;
    }
  }
  async function stopCore(): Promise<void> {
    if (stopping.value || !store.status) return;
    if (
      !(await confirmDialog({
        title: t("settings.stopConfirmTitle"),
        message: t("settings.stopConfirmMsg"),
        confirmText: t("settings.stopBtn"),
        cancelText: t("common.cancel"),
        danger: true,
      }))
    )
      return;
    if (stopping.value) return;
    stopping.value = true;
    actionGeneration += 1;
    try {
      await api.stopCore();
      await refreshRuntimeState();
    } catch (error) {
      toast.error(t("toast.failed", { msg: errorText(error) }));
    } finally {
      stopping.value = false;
    }
  }
  return { restarting, stopping, cancellingUpdate, restartCore, stopCore, cancelCoreUpdate };
}
