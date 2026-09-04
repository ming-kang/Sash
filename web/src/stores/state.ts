import { computed, shallowReactive } from "vue";
import type {
  ConnectionItem,
  LogMessage,
  OutboundMode,
  ProfileMeta,
  ProfilesResponse,
  ProxyItem,
  RuleItem,
  SashStatus,
} from "../types/index.js";
import {
  canSetSystemProxyTarget,
  clearCoreOwnedState,
  isCoreHealthy,
  RequestGenerations,
  runtimeNoticeKind,
  runtimeOwnerKey,
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

export const HISTORY_LEN = 60;
export const requests = new RequestGenerations();

interface RuntimeOwnershipState {
  observedOwner: string | null;
  snapshotProfileRevision: number | null;
  lastDaemonStartedAt: string | null;
}

export const runtimeOwnership: RuntimeOwnershipState = {
  observedOwner: null,
  snapshotProfileRevision: null,
  lastDaemonStartedAt: null,
};

// Shallow on purpose: collections (connections, rules, proxies, logs, traffic)
// hold thousands of entries and are always replaced by reference, never mutated
// in place. Deep proxies would wrap every nested object on every poll cycle.
export const store = shallowReactive<StoreState>({
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

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function setProfiles(response: ProfilesResponse): void {
  store.profiles = response.profiles;
  store.activeProfileId = response.activeId;
}

export function transitionRuntimeOwner(status: SashStatus | null): void {
  const nextOwner = runtimeOwnerKey(status);
  if (nextOwner === runtimeOwnership.observedOwner) {
    if (nextOwner === null) {
      store.coreSnapshotAvailable = false;
      store.coreSnapshotError = null;
      runtimeOwnership.snapshotProfileRevision = null;
    }
    return;
  }

  runtimeOwnership.observedOwner = nextOwner;
  runtimeOwnership.snapshotProfileRevision = null;
  store.coreSnapshotAvailable = false;
  store.coreSnapshotError = null;
  clearCoreOwnedState(store, HISTORY_LEN);
}

export function adoptDaemonStatus(status: SashStatus): void {
  if (runtimeOwnership.lastDaemonStartedAt !== status.daemon.startedAt) {
    requests.invalidate("profiles");
    store.lastProfileRevision = null;
  }
  runtimeOwnership.lastDaemonStartedAt = status.daemon.startedAt;
  store.status = status;
  store.daemonOnline = true;
  transitionRuntimeOwner(status);
}

export function coreRequestIsCurrent(status: SashStatus, runtimeRequest: number): boolean {
  return (
    requests.isCurrent("runtime", runtimeRequest) &&
    runtimeOwnerKey(status) !== null &&
    runtimeOwnerKey(store.status) === runtimeOwnerKey(status)
  );
}

export function recordCoreSnapshotError(
  status: SashStatus,
  runtimeRequest: number,
  error: unknown,
): void {
  if (!coreRequestIsCurrent(status, runtimeRequest)) return;
  store.coreSnapshotError = errorText(error).slice(0, 300);
}
