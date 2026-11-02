import { shallowRef } from "vue";
import { api } from "../api/index.js";
import { t } from "../i18n/index.js";
import { errorText, proxyChain, store, toast, updateProxyDelay } from "../stores/index.js";
import type { ProxyDelay } from "../types/index.js";

const GROUP_CONCURRENCY = 8;

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      /\b(timeout|timed out|deadline exceeded)\b/i.test(error.message))
  );
}

/** Group cards show their routed node's delay, so measuring that node keeps both cards in step. */
function measuredTarget(name: string): string {
  return proxyChain(name).at(-1) ?? name;
}

export function useProxyLatency() {
  const testingGroups = shallowRef(new Set<string>());
  const testingNodes = shallowRef(new Set<string>());

  function clearTestingNodes(names: Iterable<string>): void {
    const next = new Set(testingNodes.value);
    for (const name of names) next.delete(name);
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
    const targetOf = new Map(members.map((name) => [name, measuredTarget(name)]));
    const targets = [...new Set(targetOf.values())];
    const busy = [...new Set([...members, ...targets])];
    if (members.length === 0 || busy.some((name) => testingNodes.value.has(name))) return;
    testingGroups.value = new Set(testingGroups.value).add(group);
    testingNodes.value = new Set([...testingNodes.value, ...busy]);
    const generation = store.runtimeGeneration;
    const results: ProxyDelay[] = Array(targets.length);
    let cursor = 0;

    async function worker(): Promise<void> {
      while (cursor < targets.length) {
        const index = cursor++;
        const name = targets[index];
        if (!name) continue;
        const result = await measure(name, generation);
        results[index] = result.delay;
        clearTestingNodes([name, ...members.filter((member) => targetOf.get(member) === name)]);
      }
    }

    try {
      await Promise.all(
        Array.from({ length: Math.min(GROUP_CONCURRENCY, targets.length) }, () => worker()),
      );
      if (generation !== store.runtimeGeneration) return;
      // Each card already shows its delay or timeout; only request failures need a summary.
      const timeouts = results.filter((delay) => delay === 0).length;
      const failures = results.filter((delay) => delay === "failed").length;
      if (failures) {
        toast.warning(
          t("toast.testGroupPartial", {
            name: group,
            n: results.length - timeouts - failures,
            timeouts,
            failures,
          }),
        );
      }
    } finally {
      clearTestingNodes(busy);
      const nextGroups = new Set(testingGroups.value);
      nextGroups.delete(group);
      testingGroups.value = nextGroups;
    }
  }

  async function testSingle(name: string): Promise<void> {
    const target = measuredTarget(name);
    const busy = [...new Set([name, target])];
    if (
      busy.some((node) => testingNodes.value.has(node)) ||
      [...testingGroups.value].some((group) =>
        busy.some((node) => store.proxies[group]?.all?.includes(node)),
      )
    )
      return;
    testingNodes.value = new Set([...testingNodes.value, ...busy]);
    const generation = store.runtimeGeneration;
    try {
      const result = await measure(target, generation);
      if (generation !== store.runtimeGeneration) return;
      if (result.delay === "failed")
        toast.error(t("toast.testFailed", { name, msg: errorText(result.error) }));
    } finally {
      clearTestingNodes(busy);
    }
  }

  return { testingGroups, testingNodes, testGroup, testSingle };
}
