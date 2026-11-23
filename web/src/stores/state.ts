import { createPinia, defineStore, setActivePinia } from "pinia";
import { computed } from "vue";
import { currentRoute } from "../router.js";
import type {
  ConnectionItem,
  LogMessage,
  ProfileMeta,
  ProfilesResponse,
  ProxyDelay,
  ProxyItem,
  RoutingMode,
  RuleItem,
  SashStatus,
} from "../types/index.js";

export interface ToastItem {
  id: number;
  kind: "success" | "error" | "info" | "warning";
  text: string;
  count: number;
  duration: number;
}
export interface StoredLogMessage extends LogMessage {
  id: number;
}
export type CoreResource = "configs" | "proxies" | "rules" | "connections";
/**
 * "connecting" lasts until the first live snapshot, so a loading page never
 * flashes the offline view; "refused" means Sash answers but will not take
 * control requests from this page, which only happens off Sash's own origin.
 */
export type DaemonConnection = "connecting" | "connected" | "offline" | "refused";
export interface StoreState {
  status: SashStatus | null;
  connection: DaemonConnection;
  lastStateRevision: number | null;
  resourceLoaded: Partial<Record<CoreResource, boolean>>;
  resourceErrors: Partial<Record<CoreResource, string>>;
  mode: RoutingMode;
  traffic: { up: number; down: number; historyUp: number[]; historyDown: number[] };
  proxies: Record<string, ProxyItem>;
  proxyGroups: string[];
  manualProxyDelays: Record<string, ProxyDelay>;
  runtimeGeneration: number;
  connections: ConnectionItem[];
  connectionsUploadTotal: number;
  connectionsDownloadTotal: number;
  rules: RuleItem[];
  logs: StoredLogMessage[];
  profiles: ProfileMeta[];
  profilesLoaded: boolean;
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

function initialState(): StoreState {
  return {
    status: null,
    connection: "connecting",
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
    profilesLoaded: false,
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
  };
}

export const useAppStore = defineStore("app", { state: initialState });

// The store must resolve outside component setup too (module-level event
// wiring, tests), so the app install and standalone contexts share one Pinia.
export const pinia = createPinia();
setActivePinia(pinia);

// The store's plain-object view: `store.field` reads and writes reach the
// reactive state directly — no wrapper semantics. New code may prefer the
// idiomatic useAppStore() API; both point at the same state.
export const store: StoreState = useAppStore().$state;

export function isCoreHealthy(status: SashStatus | null): boolean {
  return Boolean(status?.core.running && status.core.healthy);
}

function systemProxyNeedsDisable(status: SashStatus | null): boolean {
  return Boolean(
    status?.systemProxy.desired ||
      (status?.systemProxy.appliedKnown && status.systemProxy.applied) ||
      (status?.systemProxy.stateKnown && status.systemProxy.actual?.enabled),
  );
}

export function canSetSystemProxyTarget(status: SashStatus | null, target: boolean): boolean {
  return target
    ? isCoreHealthy(status) && status?.systemProxy.actual?.supported !== false
    : systemProxyNeedsDisable(status);
}

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
export const isConnected = computed(() => store.connection === "connected");
export const runtimeNotice = computed(() => {
  if (store.connection === "offline") return "offline";
  if (!isConnected.value) return null;
  if (isCoreRunning.value && !isCoreReady.value) return "coreDegraded";
  if (!isCoreReady.value || coreSnapshotError.value === null) return null;
  return visibleCoreResources().some((resource) => store.resourceLoaded[resource])
    ? "coreDegraded"
    : "coreUnavailable";
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

export function resetCoreState(): void {
  store.mode = "rule";
  store.proxies = {};
  store.proxyGroups = [];
  store.connections = [];
  store.connectionsUploadTotal = 0;
  store.connectionsDownloadTotal = 0;
  store.rules = [];
  store.traffic = {
    up: 0,
    down: 0,
    historyUp: Array(HISTORY_LEN).fill(0),
    historyDown: Array(HISTORY_LEN).fill(0),
  };
  store.manualProxyDelays = {};
  store.activeGroup = "";
  store.resourceLoaded = {};
  store.resourceErrors = {};
  store.runtimeGeneration += 1;
}

let lastBootId: string | null = null;

function runtimeEpoch(status: SashStatus | null): string | null {
  return status?.core.running ? `${status.daemon.bootId}|${status.revisions.runtime}` : null;
}

export function adoptDaemonStatus(status: SashStatus): void {
  if (lastBootId !== status.daemon.bootId) {
    lastBootId = status.daemon.bootId;
    store.lastStateRevision = null;
  }
  if (runtimeEpoch(store.status) !== runtimeEpoch(status)) resetCoreState();
  store.status = status;
}
