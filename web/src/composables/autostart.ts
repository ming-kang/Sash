import { computed, onScopeDispose, type Ref, ref, watch } from "vue";
import type { AutostartStatus } from "../../../src/autostart-contract.js";
import { api } from "../api/index.js";
import { errorText } from "../stores/index.js";

/** Keep OS observations tied to the authorized daemon that requested them. */
export function useAutostart(owner: Readonly<Ref<string | null>>) {
  const status = ref<AutostartStatus | null>(null);
  const loading = ref(false);
  const saving = ref(false);
  let sequence = 0;
  let disposed = false;
  const busy = computed(() => loading.value || saving.value);

  async function refresh(): Promise<void> {
    if (!owner.value || saving.value || disposed) return;
    const request = ++sequence;
    loading.value = true;
    try {
      const result = await api.getAutostart();
      if (!disposed && request === sequence) status.value = result;
    } catch (error) {
      if (!disposed && request === sequence) {
        status.value = { state: "unknown", canEnable: false, reason: errorText(error) };
      }
    } finally {
      if (!disposed && request === sequence) loading.value = false;
    }
  }

  async function setEnabled(enabled: boolean): Promise<boolean> {
    if (!owner.value || busy.value || disposed || (enabled && !status.value?.canEnable))
      return false;
    const request = ++sequence;
    saving.value = true;
    try {
      const result = await api.setAutostart(enabled);
      if (disposed || request !== sequence) return false;
      status.value = result;
      return true;
    } catch (error) {
      // A failed HTTP response may follow a partial OS write. Re-observe it.
      if (disposed || request !== sequence) return false;
      try {
        const result = await api.getAutostart();
        if (!disposed && request === sequence) status.value = result;
      } catch {
        if (!disposed && request === sequence) {
          status.value = { state: "unknown", canEnable: false, reason: errorText(error) };
        }
      }
      if (!disposed && request === sequence) throw error;
      return false;
    } finally {
      if (!disposed && request === sequence) saving.value = false;
    }
  }

  watch(
    owner,
    () => {
      sequence += 1;
      loading.value = false;
      saving.value = false;
      status.value = null;
      void refresh();
    },
    { immediate: true, flush: "sync" },
  );
  onScopeDispose(() => {
    disposed = true;
    sequence += 1;
  });
  return { status, busy, refresh, setEnabled };
}
