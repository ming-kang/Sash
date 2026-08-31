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

export interface ToastItem {
  id: number;
  kind: "success" | "error" | "info";
  text: string;
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
  connections: ConnectionItem[];
  connectionsUploadTotal: number;
  connectionsDownloadTotal: number;
  rules: RuleItem[];
  logs: LogMessage[];
  activeGroup: string;
  toasts: ToastItem[];
}

const HISTORY_LEN = 60;
const LOG_LEN = 600;

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
  connections: [],
  connectionsUploadTotal: 0,
  connectionsDownloadTotal: 0,
  rules: [],
  logs: [],
  activeGroup: "",
  toasts: [],
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
  if (!item) return;
  if (!item.history) item.history = [];
  item.history.push({ time: new Date().toISOString(), delay });
}

export function proxyDelay(name: string): number | undefined {
  const item = store.proxies[name];
  const history = item?.history ?? [];
  return history.length > 0 ? history[history.length - 1]?.delay : undefined;
}

export function addTraffic(msg: TrafficMessage): void {
  store.traffic.up = msg.up;
  store.traffic.down = msg.down;
  store.traffic.historyUp.push(msg.up);
  store.traffic.historyDown.push(msg.down);
  if (store.traffic.historyUp.length > HISTORY_LEN) store.traffic.historyUp.shift();
  if (store.traffic.historyDown.length > HISTORY_LEN) store.traffic.historyDown.shift();
}

export function addLog(msg: LogMessage): void {
  store.logs.push(msg);
  if (store.logs.length > LOG_LEN) store.logs.shift();
}

let toastSeq = 0;

export function pushToast(kind: ToastItem["kind"], text: string): void {
  const id = ++toastSeq;
  store.toasts.push({ id, kind, text });
  window.setTimeout(() => dismissToast(id), 4200);
}

export function dismissToast(id: number): void {
  const idx = store.toasts.findIndex((t) => t.id === id);
  if (idx >= 0) store.toasts.splice(idx, 1);
}

export const toast = {
  success: (text: string) => pushToast("success", text),
  error: (text: string) => pushToast("error", text),
  info: (text: string) => pushToast("info", text),
};

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
