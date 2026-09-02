import { computed, reactive } from "vue";
import type {
  ProfileActionResponse,
  ProfilesUpdateAllResponse,
  ProfileUpdateResponse,
} from "../../../src/contracts.js";
import { api } from "../api/index.js";
import type {
  ConnectionItem,
  ConnectionsResponse,
  LogMessage,
  OutboundMode,
  ProfileMeta,
  ProfilesResponse,
  ProxyItem,
  RuleItem,
  SashStatus,
  TrafficMessage,
} from "../types/index.js";
import {
  canSetSystemProxyTarget,
  clearCoreOwnedState,
  isCoreHealthy,
  RequestGenerations,
  resolvedProxyDelay,
  runProfileMutationSequence,
  runtimeCoherenceKey,
  syncCommittedBooleanSetting,
  systemProxyNeedsDisable,
} from "./state-ownership.js";

export interface ToastItem {
  id: number;
  kind: "success" | "error" | "info";
  text: string;
}

export interface StoredLogMessage extends LogMessage {
  id: number;
}

export interface StoreState {
  status: SashStatus | null;
  daemonOnline: boolean;
  mode: OutboundMode;
  traffic: {
    up: number;
    down: number;
    historyUp: number[];
    historyDown: number[];
  };
  proxies: Record<string, ProxyItem>;
  proxyGroups: string[];
  manualProxyDelays: Record<string, number>;
  runtimeGeneration: number;
  connections: ConnectionItem[];
  connectionsUploadTotal: number;
  connectionsDownloadTotal: number;
  rules: RuleItem[];
  logs: StoredLogMessage[];
  profiles: ProfileMeta[];
  activeProfileId: string | null;
  activeGroup: string;
  operations: {
    profileMutation: boolean;
    mode: boolean;
    systemProxy: boolean;
    networkSetting: boolean;
    proxySelections: Record<string, boolean>;
  };
  toasts: ToastItem[];
}

const HISTORY_LEN = 60;
const LOG_LEN = 600;
const requests = new RequestGenerations();
let coherentRuntimeKey: string | null = null;
let lastDaemonStartedAt: string | null = null;

export const store = reactive<StoreState>({
  status: null,
  daemonOnline: true,
  mode: "rule",
  traffic: {
    up: 0,
    down: 0,
    historyUp: Array(HISTORY_LEN).fill(0),
    historyDown: Array(HISTORY_LEN).fill(0),
  },
  proxies: {},
  proxyGroups: [],
  manualProxyDelays: {},
  runtimeGeneration: 0,
  connections: [],
  connectionsUploadTotal: 0,
  connectionsDownloadTotal: 0,
  rules: [],
  logs: [],
  profiles: [],
  activeProfileId: null,
  activeGroup: "",
  operations: {
    profileMutation: false,
    mode: false,
    systemProxy: false,
    networkSetting: false,
    proxySelections: {},
  },
  toasts: [],
});

export const isSysProxyOn = computed(() => systemProxyNeedsDisable(store.status));
export const isCoreRunning = computed(() => store.status?.core.running ?? false);
export const isCoreReady = computed(() => isCoreHealthy(store.status));
export const canToggleSystemProxy = computed(
  () =>
    !store.operations.systemProxy &&
    canSetSystemProxyTarget(store.status, !systemProxyNeedsDisable(store.status)),
);

export function normalizeConnections(
  connections: ConnectionsResponse["connections"],
): ConnectionItem[] {
  return connections ?? [];
}

export function setProfiles(res: ProfilesResponse): void {
  store.profiles = res.profiles;
  store.activeProfileId = res.activeId;
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

function resetCoreSnapshots(): void {
  const alreadyEmpty =
    coherentRuntimeKey === null &&
    Object.keys(store.proxies).length === 0 &&
    store.connections.length === 0 &&
    store.rules.length === 0 &&
    Object.keys(store.manualProxyDelays).length === 0 &&
    store.traffic.up === 0 &&
    store.traffic.down === 0;
  if (!alreadyEmpty) clearCoreOwnedState(store, HISTORY_LEN);
  coherentRuntimeKey = null;
}

export function resetTraffic(): void {
  store.traffic.up = 0;
  store.traffic.down = 0;
  store.traffic.historyUp = Array(HISTORY_LEN).fill(0);
  store.traffic.historyDown = Array(HISTORY_LEN).fill(0);
}

export function markDaemonOffline(): void {
  store.daemonOnline = false;
  store.status = null;
  resetCoreSnapshots();
}

async function refreshFullRuntime(
  status: SashStatus,
  runtimeRequest: number,
  profileRequest: number,
): Promise<boolean> {
  const [profiles, configs, proxies, rules, connections] = await Promise.all([
    api.getProfiles(),
    api.getConfigs(),
    api.getProxies(),
    api.getRules(),
    api.getConnections(),
  ]);
  if (
    !requests.isCurrent("runtime", runtimeRequest) ||
    !requests.isCurrent("profiles", profileRequest)
  ) {
    return false;
  }

  store.status = status;
  store.daemonOnline = true;
  setProfiles(profiles);
  store.mode = configs.mode;
  setProxies(proxies.proxies);
  store.rules = rules.rules;
  store.connections = normalizeConnections(connections.connections);
  store.connectionsUploadTotal = connections.uploadTotal;
  store.connectionsDownloadTotal = connections.downloadTotal;
  coherentRuntimeKey = runtimeCoherenceKey(status);
  lastDaemonStartedAt = status.daemon.startedAt;
  return true;
}

export async function refreshRuntimeState(): Promise<void> {
  const runtimeRequest = requests.begin("runtime");
  const profileRequest = requests.begin("profiles");
  const status = await api.getStatus();
  if (!requests.isCurrent("runtime", runtimeRequest)) return;

  if (!isCoreHealthy(status)) {
    store.status = status;
    store.daemonOnline = true;
    resetCoreSnapshots();
    const profiles = await api.getProfiles();
    if (
      requests.isCurrent("runtime", runtimeRequest) &&
      requests.isCurrent("profiles", profileRequest)
    ) {
      setProfiles(profiles);
      lastDaemonStartedAt = status.daemon.startedAt;
    }
    return;
  }

  if (runtimeCoherenceKey(status) !== coherentRuntimeKey) resetCoreSnapshots();
  await refreshFullRuntime(status, runtimeRequest, profileRequest);
}

export async function refreshStatus(): Promise<"full" | "status" | "stopped"> {
  const runtimeRequest = requests.begin("runtime");
  const status = await api.getStatus();
  if (!requests.isCurrent("runtime", runtimeRequest)) return "status";

  if (!isCoreHealthy(status)) {
    const daemonChanged = lastDaemonStartedAt !== status.daemon.startedAt;
    store.status = status;
    store.daemonOnline = true;
    resetCoreSnapshots();
    if (daemonChanged) {
      const profileRequest = requests.begin("profiles");
      const profiles = await api.getProfiles();
      if (
        requests.isCurrent("runtime", runtimeRequest) &&
        requests.isCurrent("profiles", profileRequest)
      ) {
        setProfiles(profiles);
        lastDaemonStartedAt = status.daemon.startedAt;
      }
    }
    return "stopped";
  }

  const nextKey = runtimeCoherenceKey(status);
  if (nextKey !== coherentRuntimeKey) {
    resetCoreSnapshots();
    const profileRequest = requests.begin("profiles");
    await refreshFullRuntime(status, runtimeRequest, profileRequest);
    return "full";
  }

  store.status = status;
  store.daemonOnline = true;
  lastDaemonStartedAt = status.daemon.startedAt;
  return "status";
}

export async function refreshConnections(): Promise<void> {
  if (!isCoreHealthy(store.status)) return;
  const runtimeRequest = requests.begin("runtime");
  const connections = await api.getConnections();
  if (!requests.isCurrent("runtime", runtimeRequest) || !isCoreHealthy(store.status)) return;
  store.connections = normalizeConnections(connections.connections);
  store.connectionsUploadTotal = connections.uploadTotal;
  store.connectionsDownloadTotal = connections.downloadTotal;
}

export async function refreshProxies(): Promise<void> {
  if (!isCoreHealthy(store.status)) return;
  const runtimeRequest = requests.begin("runtime");
  const proxies = await api.getProxies();
  if (!requests.isCurrent("runtime", runtimeRequest) || !isCoreHealthy(store.status)) return;
  setProxies(proxies.proxies);
}

export async function refreshRules(): Promise<void> {
  if (!isCoreHealthy(store.status)) return;
  const runtimeRequest = requests.begin("runtime");
  const rules = await api.getRules();
  if (!requests.isCurrent("runtime", runtimeRequest) || !isCoreHealthy(store.status)) return;
  store.rules = rules.rules;
}

export async function refreshProfiles(): Promise<void> {
  const profileRequest = requests.begin("profiles");
  const profiles = await api.getProfiles();
  if (requests.isCurrent("profiles", profileRequest)) setProfiles(profiles);
}

/** Self-scheduling polling prevents overlapping cycles and only probes Core after a healthy status. */
export function startRuntimePolling(intervalMs = 2000): () => void {
  const backgroundIntervalMs = Math.max(intervalMs, 15_000);
  let stopped = false;
  let running = false;
  let refreshWhenIdle = false;
  let timer: number | null = null;
  let cycle = 0;

  const clearTimer = (): void => {
    if (timer === null) return;
    window.clearTimeout(timer);
    timer = null;
  };

  const schedule = (delayMs: number): void => {
    clearTimer();
    timer = window.setTimeout(() => {
      timer = null;
      void tick();
    }, delayMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await api.initialize();
      const result = await refreshStatus();
      cycle += 1;
      if (result === "status" && isCoreHealthy(store.status)) {
        await refreshConnections().catch(() => undefined);
        if (cycle % 3 === 0) await refreshProxies().catch(() => undefined);
      }
    } catch {
      api.clearSession();
      markDaemonOffline();
    } finally {
      running = false;
      if (!stopped) {
        if (refreshWhenIdle && !document.hidden) {
          refreshWhenIdle = false;
          schedule(0);
        } else {
          schedule(document.hidden ? backgroundIntervalMs : intervalMs);
        }
      }
    }
  };

  const onVisibilityChange = (): void => {
    if (stopped) return;
    clearTimer();
    if (document.hidden) {
      refreshWhenIdle = false;
      if (!running) schedule(backgroundIntervalMs);
    } else if (running) {
      refreshWhenIdle = true;
    } else {
      void tick();
    }
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  void tick();
  return () => {
    stopped = true;
    refreshWhenIdle = false;
    clearTimer();
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

export async function setSystemProxyEnabled(target: boolean): Promise<void> {
  if (store.operations.systemProxy) return;
  if (!canSetSystemProxyTarget(store.status, target)) {
    throw new Error(
      target ? "Cannot enable system proxy: Core is not healthy" : "System proxy is already off",
    );
  }
  store.operations.systemProxy = true;
  requests.invalidate("runtime");
  try {
    if (target) await api.enableSystemProxy();
    else await api.disableSystemProxy();
    if (store.status) {
      store.status = {
        ...store.status,
        systemProxy: {
          ...store.status.systemProxy,
          desired: target,
          applied: target,
        },
      };
    }
    await refreshStatus();
  } finally {
    store.operations.systemProxy = false;
  }
}

export async function patchBooleanSetting(key: "allow-lan" | "tun", next: boolean): Promise<void> {
  if (store.operations.networkSetting) return;
  store.operations.networkSetting = true;
  requests.invalidate("runtime");
  try {
    const result = await api.patchSetting(key, next ? "on" : "off");
    store.status = syncCommittedBooleanSetting(store.status, key, next, result.settings);
    await refreshRuntimeState();
  } finally {
    store.operations.networkSetting = false;
  }
}

export async function setOutboundMode(mode: OutboundMode): Promise<void> {
  if (store.operations.mode || mode === store.mode) return;
  if (!isCoreHealthy(store.status)) throw new Error("Core is not healthy");
  store.operations.mode = true;
  requests.invalidate("runtime");
  const generation = requests.begin("mode");
  try {
    await api.setMode(mode);
    requests.invalidate("runtime");
    if (requests.isCurrent("mode", generation)) store.mode = mode;
  } finally {
    if (requests.isCurrent("mode", generation)) store.operations.mode = false;
  }
}

export async function selectGroupProxy(groupName: string, proxyName: string): Promise<void> {
  if (store.operations.proxySelections[groupName]) return;
  if (!isCoreHealthy(store.status)) throw new Error("Core is not healthy");
  store.operations.proxySelections[groupName] = true;
  requests.invalidate("runtime");
  const domain = `proxy-selection:${groupName}`;
  const generation = requests.begin(domain);
  try {
    await api.selectProxy(groupName, proxyName);
    requests.invalidate("runtime");
    if (requests.isCurrent(domain, generation) && store.proxies[groupName]) {
      store.proxies[groupName].now = proxyName;
    }
  } finally {
    if (requests.isCurrent(domain, generation)) delete store.operations.proxySelections[groupName];
  }
}

async function performProfileMutation<T>(
  mutation: () => Promise<T>,
  refreshesRuntime: (result: T) => boolean,
): Promise<T> {
  if (store.operations.profileMutation) throw new Error("A profile operation is already running");
  store.operations.profileMutation = true;
  requests.invalidate("runtime");
  requests.invalidate("profiles");
  try {
    return await runProfileMutationSequence(mutation, refreshProfiles, async (result) => {
      if (refreshesRuntime(result)) await refreshRuntimeState();
    });
  } finally {
    store.operations.profileMutation = false;
  }
}

export function addProfile(url: string): Promise<ProfileActionResponse> {
  return performProfileMutation(
    () => api.addProfile(url),
    (result) => result.activated,
  );
}

export function importProfile(name: string, content: string): Promise<ProfileActionResponse> {
  return performProfileMutation(
    () => api.importProfile(name, content),
    (result) => result.activated,
  );
}

export function updateProfile(id: string): Promise<ProfileUpdateResponse> {
  return performProfileMutation(
    () => api.updateProfile(id),
    (result) => result.proxyCount !== undefined,
  );
}

export function updateAllProfiles(): Promise<ProfilesUpdateAllResponse> {
  return performProfileMutation(
    () => api.updateAllProfiles(),
    (result) => result.proxyCount !== undefined,
  );
}

export function activateProfile(
  id: string | null,
): Promise<{ ok: boolean; activeId: string | null; proxyCount: number }> {
  return performProfileMutation(
    () => api.setActiveProfile(id),
    () => true,
  );
}

export function deleteProfile(
  id: string,
): Promise<{ ok: boolean; wasActive: boolean; proxyCount?: number }> {
  return performProfileMutation(
    () => api.deleteProfile(id),
    (result) => result.wasActive,
  );
}

export function updateProxyDelay(name: string, delay: number, generation: number): void {
  if (generation !== store.runtimeGeneration || !store.proxies[name]) return;
  store.manualProxyDelays[name] = delay;
}

export function proxyDelay(name: string): number | undefined {
  return resolvedProxyDelay(name, store.proxies, store.manualProxyDelays);
}

export function addTraffic(msg: TrafficMessage): void {
  if (!isCoreHealthy(store.status)) return;
  store.traffic.up = msg.up;
  store.traffic.down = msg.down;
  store.traffic.historyUp.push(msg.up);
  store.traffic.historyDown.push(msg.down);
  if (store.traffic.historyUp.length > HISTORY_LEN) store.traffic.historyUp.shift();
  if (store.traffic.historyDown.length > HISTORY_LEN) store.traffic.historyDown.shift();
}

let logSeq = 0;

export function addLog(msg: LogMessage): void {
  store.logs.push({ ...msg, id: ++logSeq });
  if (store.logs.length > LOG_LEN) store.logs.shift();
}

export function clearLogs(): void {
  store.logs = [];
}

let toastSeq = 0;

export function pushToast(kind: ToastItem["kind"], text: string): void {
  const id = ++toastSeq;
  store.toasts.push({ id, kind, text });
  window.setTimeout(() => dismissToast(id), 4200);
}

export function dismissToast(id: number): void {
  const index = store.toasts.findIndex((item) => item.id === id);
  if (index >= 0) store.toasts.splice(index, 1);
}

export const toast = {
  success: (text: string) => pushToast("success", text),
  error: (text: string) => pushToast("error", text),
  info: (text: string) => pushToast("info", text),
};

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
