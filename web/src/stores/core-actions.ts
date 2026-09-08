import { isPlainObject } from "../../../src/json-shape.js";
import { api } from "../api/index.js";
import { currentRoute } from "../router.js";
import type {
  ConnectionItem,
  ConnectionsResponse,
  OutboundMode,
  ProxyItem,
} from "../types/index.js";
import {
  type CoreResource,
  errorText,
  HISTORY_LEN,
  requests,
  store,
  visibleCoreResources,
} from "./state.js";
import { isCoreHealthy, resolvedProxyDelay, runtimeOwnerKey } from "./state-ownership.js";

export function normalizeConnections(value: ConnectionsResponse["connections"]): ConnectionItem[] {
  if (value === null) return [];
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        !isPlainObject(item) || !isPlainObject(item.metadata) || typeof item.id !== "string",
    )
  )
    throw new Error("Invalid Core connections");
  return value;
}

export function setProxies(proxies: Record<string, ProxyItem>): void {
  if (
    !isPlainObject(proxies) ||
    Object.values(proxies).some(
      (proxy) =>
        !isPlainObject(proxy) || typeof proxy.name !== "string" || typeof proxy.type !== "string",
    )
  )
    throw new Error("Invalid Core proxies");
  const groupTypes = new Set(["Selector", "URLTest", "Fallback", "LoadBalance", "Relay"]);
  const groups = Object.keys(proxies).filter(
    (name) => groupTypes.has(proxies[name]?.type ?? "") || Array.isArray(proxies[name]?.all),
  );
  store.proxies = proxies;
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

async function refreshResource<T>(
  resource: CoreResource,
  fetch: () => Promise<T>,
  adopt: (result: T) => void,
): Promise<void> {
  if (!isCoreHealthy(store.status)) return;
  const owner = runtimeOwnerKey(store.status);
  const generation = requests.begin(resource);
  const current = () =>
    requests.isCurrent(resource, generation) && runtimeOwnerKey(store.status) === owner;
  try {
    const result = await fetch();
    if (!current()) return;
    adopt(result);
    store.resourceLoaded = { ...store.resourceLoaded, [resource]: true };
    const errors = { ...store.resourceErrors };
    delete errors[resource];
    store.resourceErrors = errors;
  } catch (error) {
    if (current())
      store.resourceErrors = {
        ...store.resourceErrors,
        [resource]: errorText(error).slice(0, 300),
      };
    throw error;
  }
}

export async function refreshConfigs(): Promise<void> {
  if (store.operations.mode) return;
  return refreshResource("configs", api.getConfigs, (result) => {
    if (!["rule", "global", "direct"].includes(result.mode)) throw new Error("Invalid Core mode");
    store.mode = result.mode;
  });
}
export function refreshConnections(): Promise<void> {
  return refreshResource("connections", api.getConnections, (result) => {
    const connections = normalizeConnections(result.connections);
    if (
      ![result.uploadTotal, result.downloadTotal].every(
        (value) => Number.isFinite(value) && value >= 0,
      )
    )
      throw new Error("Invalid Core traffic totals");
    store.connections = connections;
    store.connectionsUploadTotal = result.uploadTotal;
    store.connectionsDownloadTotal = result.downloadTotal;
  });
}
export async function refreshProxies(): Promise<void> {
  if (Object.keys(store.operations.proxySelections).length) return;
  return refreshResource("proxies", api.getProxies, (result) => setProxies(result.proxies));
}
export function refreshRules(): Promise<void> {
  return refreshResource("rules", api.getRules, (result) => {
    if (
      !Array.isArray(result.rules) ||
      result.rules.some(
        (rule) =>
          !isPlainObject(rule) ||
          typeof rule.type !== "string" ||
          typeof rule.proxy !== "string" ||
          typeof rule.payload !== "string",
      )
    )
      throw new Error("Invalid Core rules");
    store.rules = result.rules;
  });
}

/** Resource failures are independent; only visible consumers request data. */
export async function refreshVisibleCoreResources(cycle = 0, force = false): Promise<void> {
  const refresh = {
    configs: refreshConfigs,
    proxies: refreshProxies,
    rules: refreshRules,
    connections: refreshConnections,
  };
  const due = visibleCoreResources().filter((resource) => {
    if (force || !store.resourceLoaded[resource]) return true;
    if (resource === "rules") return false;
    if (resource === "connections") return currentRoute.value === "connections" || cycle % 5 === 0;
    return cycle % 3 === 0;
  });
  await Promise.allSettled(due.map((resource) => refresh[resource]()));
}

export async function closeConnection(id: string): Promise<void> {
  if (!isCoreHealthy(store.status)) throw new Error("Core is not healthy");
  const owner = runtimeOwnerKey(store.status);
  requests.invalidate("connections");
  await api.closeConnection(id);
  requests.invalidate("connections");
  if (runtimeOwnerKey(store.status) === owner)
    store.connections = store.connections.filter((connection) => connection.id !== id);
}
export async function closeAllConnections(): Promise<void> {
  if (!isCoreHealthy(store.status)) throw new Error("Core is not healthy");
  const owner = runtimeOwnerKey(store.status);
  requests.invalidate("connections");
  await api.closeAllConnections();
  requests.invalidate("connections");
  if (runtimeOwnerKey(store.status) === owner) store.connections = [];
}

export async function setOutboundMode(mode: OutboundMode): Promise<void> {
  if (store.operations.mode || mode === store.mode) return;
  if (!isCoreHealthy(store.status)) throw new Error("Core is not healthy");
  const owner = runtimeOwnerKey(store.status);
  store.operations = { ...store.operations, mode: true };
  requests.invalidate("configs");
  try {
    await api.setMode(mode);
    if (runtimeOwnerKey(store.status) === owner) store.mode = mode;
  } finally {
    requests.invalidate("configs");
    store.operations = { ...store.operations, mode: false };
  }
}

export async function selectGroupProxy(groupName: string, proxyName: string): Promise<void> {
  if (store.operations.proxySelections[groupName]) return;
  if (!isCoreHealthy(store.status)) throw new Error("Core is not healthy");
  const owner = runtimeOwnerKey(store.status);
  store.operations = {
    ...store.operations,
    proxySelections: { ...store.operations.proxySelections, [groupName]: true },
  };
  requests.invalidate("proxies");
  try {
    await api.selectProxy(groupName, proxyName);
    const group = store.proxies[groupName];
    if (group && runtimeOwnerKey(store.status) === owner)
      store.proxies = { ...store.proxies, [groupName]: { ...group, now: proxyName } };
  } finally {
    requests.invalidate("proxies");
    const selections = { ...store.operations.proxySelections };
    delete selections[groupName];
    store.operations = { ...store.operations, proxySelections: selections };
  }
}

export function updateProxyDelay(name: string, delay: number, generation: number): void {
  if (generation === store.runtimeGeneration && store.proxies[name])
    store.manualProxyDelays = { ...store.manualProxyDelays, [name]: delay };
}
export function updateProxyDelays(delays: Record<string, number>, generation: number): void {
  if (generation !== store.runtimeGeneration) return;
  const merged = { ...store.manualProxyDelays };
  for (const [name, delay] of Object.entries(delays)) if (store.proxies[name]) merged[name] = delay;
  store.manualProxyDelays = merged;
}
export function proxyDelay(name: string): number | undefined {
  return resolvedProxyDelay(name, store.proxies, store.manualProxyDelays);
}
