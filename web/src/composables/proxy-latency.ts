import { shallowRef } from "vue";
import { api } from "../api/index.js";
import { t } from "../i18n/index.js";
import { errorText, store, toast, updateProxyDelay, updateProxyDelays } from "../stores/index.js";
import type { ProxyDelay } from "../types/index.js";

export function useProxyLatency() {
  const testingGroups = shallowRef(new Set<string>());
  const testingNodes = shallowRef(new Set<string>());

  async function testGroup(group: string): Promise<void> {
    if (testingGroups.value.has(group)) return;
    testingGroups.value = new Set(testingGroups.value).add(group);
    const generation = store.runtimeGeneration;
    try {
      const delays = await api.testGroupDelay(group);
      if (generation !== store.runtimeGeneration) return;
      const members = store.proxies[group]?.all ?? Object.keys(delays);
      const results = Object.fromEntries(
        members.map((name): [string, ProxyDelay] => {
          const delay = delays[name];
          return [
            name,
            typeof delay === "number" && Number.isFinite(delay) && delay >= 0 ? delay : "failed",
          ];
        }),
      );
      updateProxyDelays(results, generation);
      const values = Object.values(results);
      const timeouts = values.filter((delay) => delay === 0).length;
      const failures = values.filter((delay) => delay === "failed").length;
      const message = t("toast.testGroupDone", {
        name: group,
        n: values.length - timeouts - failures,
        timeouts,
        failures,
      });
      if (timeouts || failures) toast.error(message);
      else toast.success(message);
    } catch (error) {
      if (generation === store.runtimeGeneration)
        toast.error(t("toast.failed", { msg: errorText(error) }));
    } finally {
      const next = new Set(testingGroups.value);
      next.delete(group);
      testingGroups.value = next;
    }
  }

  async function testSingle(name: string): Promise<void> {
    if (
      testingNodes.value.has(name) ||
      [...testingGroups.value].some((group) => store.proxies[group]?.all?.includes(name))
    )
      return;
    testingNodes.value = new Set(testingNodes.value).add(name);
    const generation = store.runtimeGeneration;
    try {
      const { delay } = await api.testProxyDelay(name);
      if (!Number.isFinite(delay) || delay < 0) throw new Error(t("errors.latencyInvalid"));
      if (generation !== store.runtimeGeneration) return;
      updateProxyDelay(name, delay, generation);
      if (delay === 0) toast.error(t("toast.testTimeout", { name }));
      else toast.success(t("toast.testNodeDone", { name, delay }));
    } catch (error) {
      if (generation !== store.runtimeGeneration) return;
      const timeout =
        error instanceof Error &&
        (error.name === "TimeoutError" ||
          /\b(timeout|timed out|deadline exceeded)\b/i.test(error.message));
      updateProxyDelay(name, timeout ? 0 : "failed", generation);
      toast.error(
        timeout
          ? t("toast.testTimeout", { name })
          : t("toast.testFailed", { name, msg: errorText(error) }),
      );
    } finally {
      const next = new Set(testingNodes.value);
      next.delete(name);
      testingNodes.value = next;
    }
  }

  return { testingGroups, testingNodes, testGroup, testSingle };
}
