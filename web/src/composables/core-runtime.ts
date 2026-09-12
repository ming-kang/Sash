import { computed, ref } from "vue";
import { api } from "../api/index.js";
import { confirmDialog } from "../components/confirm.js";
import { t } from "../i18n/index.js";
import { errorText, refreshRuntimeState, store, toast } from "../stores/index.js";

export const coreVersion = computed(() => {
  const version = store.status?.core.version;
  return version ? (version.startsWith("v") ? version : `v${version}`) : "";
});

/**
 * Live Core install/update progress, shown while the daemon stages a binary.
 * Empty when no update is running.
 */
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
let actionGeneration = 0;

/** Shared busy state and actions for every Core control in the dashboard. */
export function useCoreControl() {
  async function restartCore(): Promise<void> {
    if (restarting.value || stopping.value || !store.status) return;
    if (
      store.status.core.running &&
      !(await confirmDialog({
        title: t("settings.restartConfirmTitle"),
        message: t("settings.restartConfirmMsg"),
        confirmText: t("common.confirm"),
        cancelText: t("common.cancel"),
        danger: true,
      }))
    )
      return;
    if (restarting.value || stopping.value) return;
    restarting.value = true;
    const generation = ++actionGeneration;
    try {
      await api.restartCore();
      await refreshRuntimeState();
      if (generation === actionGeneration) toast.success(t("toast.coreRestarted"));
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
    stopping.value = true;
    actionGeneration += 1;
    try {
      await api.stopCore();
      await refreshRuntimeState();
      toast.success(t("toast.coreStopped"));
    } catch (error) {
      toast.error(t("toast.failed", { msg: errorText(error) }));
    } finally {
      stopping.value = false;
    }
  }
  return { restarting, stopping, restartCore, stopCore };
}
