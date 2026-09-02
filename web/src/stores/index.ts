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
  runtimeNoticeKind,
  runtimeOwnerKey,
  syncCommittedBooleanSetting,
  systemProxyNeedsDisable,
  tunRuntimeState,
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
  lastProfileRevision: number | null;
  coreSnapshotAvailable: boolean;
  coreSnapshotError: string | null;
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
let observedRuntimeOwner: string | null = null;
let snapshotProfileRevision: number | null = null;
let lastDaemonStartedAt: string | null = null;

export const store = reactive<StoreState>({
  status: null,
  daemonOnline: true,
  lastProfileRevision: null,
  coreSnapshotAvailable: false,
  coreSnapshotError: null,
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
export const tunRuntime = computed(() => tunRuntimeState(store.status));
export const runtimeNotice = computed(() =>
  runtimeNoticeKind(
    store.daemonOnline,
    isCoreHealthy(store.status),
    store.coreSnapshotAvailable,
    store.coreSnapshotError,
  ),
);
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

function transitionRuntimeOwner(status: SashStatus | null): void {
  const nextOwner = runtimeOwnerKey(status);
  if (nextOwner === observedRuntimeOwner) {
    if (nextOwner === null) {
      store.coreSnapshotAvailable = false;
      store.coreSnapshotError = null;
      snapshotProfileRevision = null;
    }
    return;
  }

  observedRuntimeOwner = nextOwner;
  snapshotProfileRevision = null;
  store.coreSnapshotAvailable = false;
  store.coreSnapshotError = null;
  clearCoreOwnedState(store, HISTORY_LEN);
}

function adoptDaemonStatus(status: SashStatus): void {
  if (lastDaemonStartedAt !== status.daemon.startedAt) {
    requests.invalidate("profiles");
    store.lastProfileRevision = null;
  }
  lastDaemonStartedAt = status.daemon.startedAt;
  store.status = status;
  store.daemonOnline = true;
  transitionRuntimeOwner(status);
}

function coreRequestIsCurrent(status: SashStatus, runtimeRequest: number): boolean {
  return (
    requests.isCurrent("runtime", runtimeRequest) &&
    runtimeOwnerKey(status) !== null &&
    runtimeOwnerKey(store.status) === runtimeOwnerKey(status)
  );
}

function recordCoreSnapshotError(status: SashStatus, runtimeRequest: number, err: unknown): void {
  if (!coreRequestIsCurrent(status, runtimeRequest)) return;
  store.coreSnapshotError = errorText(err).slice(0, 300);
}

export function resetTraffic(): void {
  store.traffic.up = 0;
  store.traffic.down = 0;
  store.traffic.historyUp = Array(HISTORY_LEN).fill(0);
  store.traffic.historyDown = Array(HISTORY_LEN).fill(0);
}

export function markDaemonOffline(): void {
  requests.invalidate("runtime");
  requests.invalidate("profiles");
  transitionRuntimeOwner(null);
  store.daemonOnline = false;
  store.status = null;
}

async function refreshProfilesForStatus(
  status: SashStatus,
  runtimeRequest: number,
): Promise<boolean> {
  if (store.lastProfileRevision === status.revisions.profiles) return true;
  const profileRequest = requests.begin("profiles");
  try {
    const profiles = await api.getProfiles();
    if (
      !requests.isCurrent("runtime", runtimeRequest) ||
      !requests.isCurrent("profiles", profileRequest) ||
      store.status?.daemon.startedAt !== status.daemon.startedAt
    ) {
      return false;
    }
    setProfiles(profiles);
    store.lastProfileRevision = status.revisions.profiles;
    return true;
  } catch {
    return false;
  }
}

async function refreshCoreSnapshot(status: SashStatus, runtimeRequest: number): Promise<boolean> {
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

  if (snapshotProfileRevision !== null && snapshotProfileRevision !== status.revisions.profiles) {
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
  snapshotProfileRevision = status.revisions.profiles;
  store.coreSnapshotAvailable = true;
  store.coreSnapshotError = null;
  return true;
}

export async function refreshRuntimeState(): Promise<void> {
  const runtimeRequest = requests.begin("runtime");
  const status = await api.getStatus();
  if (!requests.isCurrent("runtime", runtimeRequest)) return;
  adoptDaemonStatus(status);

  const profiles = refreshProfilesForStatus(status, runtimeRequest);
  if (!isCoreHealthy(status)) {
    await profiles;
    return;
  }
  await Promise.all([profiles, refreshCoreSnapshot(status, runtimeRequest)]);
}

export async function refreshStatus(): Promise<"full" | "status" | "stopped" | "degraded"> {
  const runtimeRequest = requests.begin("runtime");
  const status = await api.getStatus();
  if (!requests.isCurrent("runtime", runtimeRequest)) return "status";
  adoptDaemonStatus(status);

  const profiles = refreshProfilesForStatus(status, runtimeRequest);
  if (!isCoreHealthy(status)) {
    await profiles;
    return "stopped";
  }

  const needsSnapshot =
    !store.coreSnapshotAvailable ||
    store.coreSnapshotError !== null ||
    snapshotProfileRevision !== status.revisions.profiles;
  if (needsSnapshot) {
    const [, refreshed] = await Promise.all([
      profiles,
      refreshCoreSnapshot(status, runtimeRequest),
    ]);
    return refreshed ? "full" : "degraded";
  }

  await profiles;
  return "status";
}

export async function refreshConnections(): Promise<void> {
  const status = store.status;
  if (status === null || !isCoreHealthy(status)) return;
  const runtimeRequest = requests.begin("runtime");
  try {
    const connections = await api.getConnections();
    if (!coreRequestIsCurrent(status, runtimeRequest)) return;
    store.connections = normalizeConnections(connections.connections);
    store.connectionsUploadTotal = connections.uploadTotal;
    store.connectionsDownloadTotal = connections.downloadTotal;
  } catch (err) {
    recordCoreSnapshotError(status, runtimeRequest, err);
    throw err;
  }
}

export async function refreshProxies(): Promise<void> {
  const status = store.status;
  if (status === null || !isCoreHealthy(status)) return;
  const runtimeRequest = requests.begin("runtime");
  try {
    const proxies = await api.getProxies();
    if (coreRequestIsCurrent(status, runtimeRequest)) setProxies(proxies.proxies);
  } catch (err) {
    recordCoreSnapshotError(status, runtimeRequest, err);
    throw err;
  }
}

export async function refreshRules(): Promise<void> {
  const status = store.status;
  if (status === null || !isCoreHealthy(status)) return;
  const runtimeRequest = requests.begin("runtime");
  try {
    const rules = await api.getRules();
    if (coreRequestIsCurrent(status, runtimeRequest)) store.rules = rules.rules;
  } catch (err) {
    recordCoreSnapshotError(status, runtimeRequest, err);
    throw err;
  }
}

export async function refreshProfiles(): Promise<void> {
  const profileRequest = requests.begin("profiles");
  const status = store.status;
  const profiles = await api.getProfiles();
  if (!requests.isCurrent("profiles", profileRequest)) return;
  setProfiles(profiles);
  if (status && store.status?.daemon.startedAt === status.daemon.startedAt) {
    store.lastProfileRevision = status.revisions.profiles;
  }
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

export function addTraffic(msg: TrafficMessage, generation = store.runtimeGeneration): void {
  if (generation !== store.runtimeGeneration || !isCoreHealthy(store.status)) return;
  store.traffic.up = msg.up;
  store.traffic.down = msg.down;
  store.traffic.historyUp.push(msg.up);
  store.traffic.historyDown.push(msg.down);
  if (store.traffic.historyUp.length > HISTORY_LEN) store.traffic.historyUp.shift();
  if (store.traffic.historyDown.length > HISTORY_LEN) store.traffic.historyDown.shift();
}

let logSeq = 0;

export function addLog(msg: LogMessage, generation = store.runtimeGeneration): void {
  if (generation !== store.runtimeGeneration) return;
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
