import { computed, reactive } from "vue";
import type {
  ConnectionItem,
  LogMessage,
  OutboundMode,
  ProxyItem,
  RuleItem,
  SashStatus,
  TrafficMessage,
} from "../types/index.js";

export interface StoreState {
  authenticated: boolean;
  status: SashStatus | null;
  mode: OutboundMode;
  traffic: {
    up: number;
    down: number;
    historyUp: number[];
    historyDown: number[];
  };
  proxies: Record<string, ProxyItem>;
  proxyGroups: string[];
  connections: ConnectionItem[];
  connectionsUploadTotal: number;
  connectionsDownloadTotal: number;
  rules: RuleItem[];
  logs: LogMessage[];
  currentTab: string;
  activeGroup: string;
}

export const store = reactive<StoreState>({
  authenticated: false,
  status: null,
  mode: "rule",
  traffic: {
    up: 0,
    down: 0,
    historyUp: Array(30).fill(0),
    historyDown: Array(30).fill(0),
  },
  proxies: {},
  proxyGroups: [],
  connections: [],
  connectionsUploadTotal: 0,
  connectionsDownloadTotal: 0,
  rules: [],
  logs: [],
  currentTab: "overview",
  activeGroup: "",
});

export const isSysProxyOn = computed(() => store.status?.systemProxy.applied ?? false);
export const isCoreRunning = computed(() => store.status?.core.running ?? false);

export function setProxies(proxies: Record<string, ProxyItem>): void {
  store.proxies = proxies;
  const groupTypes = new Set(["Selector", "URLTest", "Fallback", "LoadBalance", "Relay"]);
  const groups = Object.keys(proxies).filter(
    (name) => groupTypes.has(proxies[name]?.type ?? "") || Array.isArray(proxies[name]?.all),
  );
  store.proxyGroups = groups;
  if (!store.activeGroup || !groups.includes(store.activeGroup)) {
    store.activeGroup =
      groups.find((g) => g.toUpperCase() === "PROXY" || g.toUpperCase() === "GLOBAL") ??
      groups[0] ??
      "";
  }
}

export function updateProxyDelay(name: string, delay: number): void {
  const item = store.proxies[name];
  if (item) {
    if (!item.history) item.history = [];
    item.history.push({ time: new Date().toISOString(), delay });
  }
}

export function addTraffic(msg: TrafficMessage): void {
  store.traffic.up = msg.up;
  store.traffic.down = msg.down;
  store.traffic.historyUp.push(msg.up);
  store.traffic.historyDown.push(msg.down);
  if (store.traffic.historyUp.length > 30) store.traffic.historyUp.shift();
  if (store.traffic.historyDown.length > 30) store.traffic.historyDown.shift();
}

export function addLog(msg: LogMessage): void {
  store.logs.push(msg);
  if (store.logs.length > 600) store.logs.shift();
}
