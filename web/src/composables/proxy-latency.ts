import { ref } from "vue";
import { api } from "../api/index.js";
import { t } from "../i18n/index.js";
import { errorText, store, toast, updateProxyDelay } from "../stores/index.js";

export function useProxyLatency() {
  const testingGroups = ref(new Set<string>());
  const testingNodes = ref(new Set<string>());

  async function testGroup(group: string): Promise<void> {
    if (testingGroups.value.has(group)) return;
    testingGroups.value = new Set(testingGroups.value).add(group);
    const generation = store.runtimeGeneration;
    try {
      const delays = await api.testGroupDelay(group);
      for (const [name, delay] of Object.entries(delays)) {
        updateProxyDelay(name, delay, generation);
      }
    } catch (error) {
      toast.error(t("toast.failed", { msg: errorText(error) }));
    } finally {
      const next = new Set(testingGroups.value);
      next.delete(group);
      testingGroups.value = next;
    }
  }

  async function testSingle(name: string): Promise<void> {
    if (testingNodes.value.has(name)) return;
    testingNodes.value = new Set(testingNodes.value).add(name);
    const generation = store.runtimeGeneration;
    try {
      updateProxyDelay(name, (await api.testProxyDelay(name)).delay, generation);
    } catch {
      updateProxyDelay(name, 0, generation);
    } finally {
      const next = new Set(testingNodes.value);
      next.delete(name);
      testingNodes.value = next;
    }
  }

  return { testingGroups, testingNodes, testGroup, testSingle };
}
