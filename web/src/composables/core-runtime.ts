import { computed, type Ref, ref } from "vue";
import { api } from "../api/index.js";
import { confirmDialog } from "../components/confirm.js";
import { t } from "../i18n/index.js";
import { errorText, refreshRuntimeState, store, toast } from "../stores/index.js";

/** Core version normalized with a leading "v" (empty string when unknown). */
export const coreVersion = computed(() => {
  const version = store.status?.core.version;
  return version ? (version.startsWith("v") ? version : `v${version}`) : "";
});

/** Core restart behind a confirmation dialog; each caller gets its own busy state. */
export function useCoreRestart(): {
  restarting: Ref<boolean>;
  restartCore: () => Promise<void>;
} {
  const restarting = ref(false);

  async function restartCore(): Promise<void> {
    if (restarting.value) return;
    const ok = await confirmDialog({
      title: t("settings.restartConfirmTitle"),
      message: t("settings.restartConfirmMsg"),
      confirmText: t("common.confirm"),
      cancelText: t("common.cancel"),
      danger: true,
    });
    if (!ok) return;
    restarting.value = true;
    try {
      await api.restartCore();
      await refreshRuntimeState();
      toast.success(t("toast.coreRestarted"));
    } catch (err) {
      toast.error(t("toast.failed", { msg: errorText(err) }));
    } finally {
      restarting.value = false;
    }
  }

  return { restarting, restartCore };
}
