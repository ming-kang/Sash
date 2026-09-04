import { api } from "../api/index.js";
import type {
  ConnectionItem,
  ConnectionsResponse,
  OutboundMode,
  ProxyItem,
  SashStatus,
} from "../types/index.js";
import {
  coreRequestIsCurrent,
  HISTORY_LEN,
  recordCoreSnapshotError,
  requests,
  runtimeOwnership,
  store,
} from "./state.js";
import { isCoreHealthy, resolvedProxyDelay, runtimeOwnerKey } from "./state-ownership.js";

export function normalizeConnections(
  connections: ConnectionsResponse["connections"],
): ConnectionItem[] {
  return connections ?? [];
}

export function setProxies(proxies: Record<string, ProxyItem>): void {
  store.proxies = proxies;
  const groupTypes = new Set(["Selector", "URLTest", "Fallback", "LoadBalance", "Relay"]);
  const groups = Object.keys(proxies).filter(
    (name) => groupTypes.has(proxies[name]?.type ?? "") || Array.isArray(proxies[name]?.all),
  );
  store.proxyGroups = groups;
  if (!store.activeGroup || !groups.includes(store.activeGroup)) {
    store.activeGroup =
      groups.find((group) => ["PROXY", "GLOBAL"].includes(group.toUpperCase())) ?? groups[0] ?? "";
  }
}

export function resetTraffic(): void {
  store.traffic = {
    up: 0,
    down: 0,
    historyUp: Array(HISTORY_LEN).fill(0),
    historyDown: Array(HISTORY_LEN).fill(0),
  };
}

export async function refreshCoreSnapshot(
  status: SashStatus,
  runtimeRequest: number,
): Promise<boolean> {
  if (runtimeOwnerKey(status) === null) return false;

  const [configs, proxies, rules, connections] = await Promise.allSettled([
    api.getConfigs(),
    api.getProxies(),
    api.getRules(),
    api.getConnections(),
  ]);
  if (
    configs.status === "rejected" ||
    proxies.status === "rejected" ||
    rules.status === "rejected" ||
    connections.status === "rejected"
  ) {
    const failure = [configs, proxies, rules, connections].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    recordCoreSnapshotError(status, runtimeRequest, failure?.reason ?? "Core snapshot failed");
    return false;
  }
  if (!coreRequestIsCurrent(status, runtimeRequest)) return false;

  if (
    runtimeOwnership.snapshotProfileRevision !== null &&
    runtimeOwnership.snapshotProfileRevision !== status.revisions.profiles
  ) {
    store.manualProxyDelays = {};
    resetTraffic();
    store.runtimeGeneration += 1;
  }
  store.mode = configs.value.mode;
  setProxies(proxies.value.proxies);
  store.rules = rules.value.rules;
  store.connections = normalizeConnections(connections.value.connections);
  store.connectionsUploadTotal = connections.value.uploadTotal;
  store.connectionsDownloadTotal = connections.value.downloadTotal;
  runtimeOwnership.snapshotProfileRevision = status.revisions.profiles;
  store.coreSnapshotAvailable = true;
  store.coreSnapshotError = null;
  return true;
}

async function refreshCoreResource<T>(
  fetch: () => Promise<T>,
  adopt: (result: T) => void,
): Promise<void> {
  const status = store.status;
  if (status === null || !isCoreHealthy(status)) return;
  const runtimeRequest = requests.begin("runtime");
  try {
    const result = await fetch();
    if (coreRequestIsCurrent(status, runtimeRequest)) adopt(result);
  } catch (error) {
    recordCoreSnapshotError(status, runtimeRequest, error);
    throw error;
  }
}

export function refreshConnections(): Promise<void> {
  return refreshCoreResource(api.getConnections, (connections) => {
    store.connections = normalizeConnections(connections.connections);
    store.connectionsUploadTotal = connections.uploadTotal;
    store.connectionsDownloadTotal = connections.downloadTotal;
  });
}

export async function closeConnection(id: string): Promise<void> {
  if (!isCoreHealthy(store.status)) throw new Error("Core is not healthy");
  await api.closeConnection(id);
  store.connections = store.connections.filter((connection) => connection.id !== id);
}

export async function closeAllConnections(): Promise<void> {
  if (!isCoreHealthy(store.status)) throw new Error("Core is not healthy");
  await api.closeAllConnections();
  store.connections = [];
}

export function refreshProxies(): Promise<void> {
  return refreshCoreResource(api.getProxies, (proxies) => setProxies(proxies.proxies));
}

export function refreshRules(): Promise<void> {
  return refreshCoreResource(api.getRules, (rules) => {
    store.rules = rules.rules;
  });
}

export async function setOutboundMode(mode: OutboundMode): Promise<void> {
  if (store.operations.mode || mode === store.mode) return;
  if (!isCoreHealthy(store.status)) throw new Error("Core is not healthy");
  store.operations = { ...store.operations, mode: true };
  requests.invalidate("runtime");
  const generation = requests.begin("mode");
  try {
    await api.setMode(mode);
    requests.invalidate("runtime");
    if (requests.isCurrent("mode", generation)) store.mode = mode;
  } finally {
    if (requests.isCurrent("mode", generation)) {
      store.operations = { ...store.operations, mode: false };
    }
  }
}

export async function selectGroupProxy(groupName: string, proxyName: string): Promise<void> {
  if (store.operations.proxySelections[groupName]) return;
  if (!isCoreHealthy(store.status)) throw new Error("Core is not healthy");
  store.operations = {
    ...store.operations,
    proxySelections: { ...store.operations.proxySelections, [groupName]: true },
  };
  requests.invalidate("runtime");
  const domain = `proxy-selection:${groupName}`;
  const generation = requests.begin(domain);
  try {
    await api.selectProxy(groupName, proxyName);
    requests.invalidate("runtime");
    const group = store.proxies[groupName];
    if (requests.isCurrent(domain, generation) && group) {
      store.proxies = { ...store.proxies, [groupName]: { ...group, now: proxyName } };
    }
  } finally {
    if (requests.isCurrent(domain, generation)) {
      const proxySelections = { ...store.operations.proxySelections };
      delete proxySelections[groupName];
      store.operations = { ...store.operations, proxySelections };
    }
  }
}

export function updateProxyDelay(name: string, delay: number, generation: number): void {
  if (generation !== store.runtimeGeneration || !store.proxies[name]) return;
  store.manualProxyDelays = { ...store.manualProxyDelays, [name]: delay };
}

/** Batch variant for group latency tests: one record swap for the whole group. */
export function updateProxyDelays(delays: Record<string, number>, generation: number): void {
  if (generation !== store.runtimeGeneration) return;
  const merged = { ...store.manualProxyDelays };
  for (const [name, delay] of Object.entries(delays)) {
    if (store.proxies[name]) merged[name] = delay;
  }
  store.manualProxyDelays = merged;
}

export function proxyDelay(name: string): number | undefined {
  return resolvedProxyDelay(name, store.proxies, store.manualProxyDelays);
}
