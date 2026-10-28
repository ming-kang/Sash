import { shallowRef } from "vue";
import { api } from "../api/index.js";
import { t } from "../i18n/index.js";
import { errorText, store, toast, updateProxyDelay } from "../stores/index.js";
import type { ProxyDelay } from "../types/index.js";

const GROUP_CONCURRENCY = 8;

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      /\b(timeout|timed out|deadline exceeded)\b/i.test(error.message))
  );
}

export function useProxyLatency() {
  const testingGroups = shallowRef(new Set<string>());
  const testingNodes = shallowRef(new Set<string>());

  function clearTestingNode(name: string): void {
    const next = new Set(testingNodes.value);
    next.delete(name);
    testingNodes.value = next;
  }

  async function measure(
    name: string,
    generation: number,
  ): Promise<{ delay: ProxyDelay; error?: unknown }> {
    try {
      const { delay } = await api.testProxyDelay(name);
      if (!Number.isFinite(delay) || delay < 0) throw new Error(t("errors.latencyInvalid"));
      updateProxyDelay(name, delay, generation);
      return { delay };
    } catch (error) {
      const delay = isTimeout(error) ? 0 : "failed";
      updateProxyDelay(name, delay, generation);
      return { delay, error };
    }
  }

  async function testGroup(group: string): Promise<void> {
    if (testingGroups.value.has(group)) return;
    const members = [...new Set(store.proxies[group]?.all ?? [])];
    if (members.length === 0 || members.some((name) => testingNodes.value.has(name))) return;
    testingGroups.value = new Set(testingGroups.value).add(group);
    testingNodes.value = new Set([...testingNodes.value, ...members]);
    const generation = store.runtimeGeneration;
    const results: ProxyDelay[] = Array(members.length);
    let cursor = 0;

    async function worker(): Promise<void> {
      while (cursor < members.length) {
        const index = cursor++;
        const name = members[index];
        if (!name) continue;
        const result = await measure(name, generation);
        results[index] = result.delay;
        clearTestingNode(name);
      }
    }

    try {
      await Promise.all(
        Array.from({ length: Math.min(GROUP_CONCURRENCY, members.length) }, () => worker()),
      );
      if (generation !== store.runtimeGeneration) return;
      const timeouts = results.filter((delay) => delay === 0).length;
      const failures = results.filter((delay) => delay === "failed").length;
      if (timeouts || failures) {
        toast.warning(
          t("toast.testGroupPartial", {
            name: group,
            n: results.length - timeouts - failures,
            timeouts,
            failures,
          }),
        );
      } else {
        toast.success(t("toast.testGroupOk", { name: group, n: results.length }));
      }
    } finally {
      const nextNodes = new Set(testingNodes.value);
      for (const name of members) nextNodes.delete(name);
      testingNodes.value = nextNodes;
      const nextGroups = new Set(testingGroups.value);
      nextGroups.delete(group);
      testingGroups.value = nextGroups;
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
      const result = await measure(name, generation);
      if (generation !== store.runtimeGeneration) return;
      if (result.delay === 0) toast.warning(t("toast.testTimeout", { name }));
      else if (result.delay === "failed")
        toast.error(t("toast.testFailed", { name, msg: errorText(result.error) }));
      else toast.success(t("toast.testNodeDone", { name, delay: result.delay }));
    } finally {
      clearTestingNode(name);
    }
  }

  return { testingGroups, testingNodes, testGroup, testSingle };
}
