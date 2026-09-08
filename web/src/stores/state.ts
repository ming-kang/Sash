import { computed, shallowReactive } from "vue";
import { currentRoute } from "../router.js";
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
} from "./state-ownership.js";

export interface ToastItem {
  id: number;
  kind: "success" | "error" | "info";
  text: string;
}
export interface StoredLogMessage extends LogMessage {
  id: number;
}
export type CoreResource = "configs" | "proxies" | "rules" | "connections";
export interface StoreState {
  status: SashStatus | null;
  daemonOnline: boolean;
  lastStateRevision: number | null;
  resourceLoaded: Partial<Record<CoreResource, boolean>>;
  resourceErrors: Partial<Record<CoreResource, string>>;
  mode: OutboundMode;
  traffic: { up: number; down: number; historyUp: number[]; historyDown: number[] };
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
export const runtimeOwnership = {
  observedOwner: null as string | null,
  lastBootId: null as string | null,
};

// Large collections are replaced by reference; their entries do not need deep Vue proxies.
export const store = shallowReactive<StoreState>({
  status: null,
  daemonOnline: true,
  lastStateRevision: null,
  resourceLoaded: {},
  resourceErrors: {},
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

export function visibleCoreResources(): CoreResource[] {
  switch (currentRoute.value) {
    case "overview":
      return ["configs", "proxies", "connections"];
    case "connections":
      return ["connections"];
    case "rules":
      return ["rules"];
    default:
      return [];
  }
}

export const coreSnapshotError = computed(
  () =>
    visibleCoreResources()
      .map((resource) => store.resourceErrors[resource])
      .filter(Boolean)
      .join("; ") || null,
);
export const isSysProxyOn = computed(() => systemProxyNeedsDisable(store.status));
export const isCoreRunning = computed(() => store.status?.core.running ?? false);
export const isCoreReady = computed(() => isCoreHealthy(store.status));
export const runtimeNotice = computed(() => {
  if (store.daemonOnline && isCoreRunning.value && !isCoreReady.value) return "coreDegraded";
  return runtimeNoticeKind(
    store.daemonOnline,
    isCoreReady.value,
    visibleCoreResources().some((resource) => store.resourceLoaded[resource]),
    coreSnapshotError.value,
  );
});
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
  const next = runtimeOwnerKey(status);
  if (next === runtimeOwnership.observedOwner) return;
  runtimeOwnership.observedOwner = next;
  store.resourceLoaded = {};
  store.resourceErrors = {};
  clearCoreOwnedState(store, HISTORY_LEN);
}

export function adoptDaemonStatus(status: SashStatus): void {
  if (runtimeOwnership.lastBootId !== status.daemon.bootId) {
    requests.invalidate("profiles");
    store.lastStateRevision = null;
  }
  runtimeOwnership.lastBootId = status.daemon.bootId;
  store.status = status;
  store.daemonOnline = true;
}
