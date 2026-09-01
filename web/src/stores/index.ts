import { computed, reactive } from "vue";
import { api } from "../api/index.js";
import type {
  ConnectionItem,
  LogMessage,
  OutboundMode,
  ProfileMeta,
  ProfilesResponse,
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
  connections: ConnectionItem[];
  connectionsUploadTotal: number;
  connectionsDownloadTotal: number;
  rules: RuleItem[];
  logs: StoredLogMessage[];
  profiles: ProfileMeta[];
  activeProfileId: string | null;
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
  profiles: [],
  activeProfileId: null,
  activeGroup: "",
  toasts: [],
});

export const isSysProxyOn = computed(() => store.status?.systemProxy.applied ?? false);
export const isCoreRunning = computed(() => store.status?.core.running ?? false);

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

export async function refreshStatus(): Promise<void> {
  store.status = await api.getStatus();
  store.daemonOnline = true;
}

export async function refreshConnections(): Promise<void> {
  const connections = await api.getConnections();
  store.connections = connections.connections;
  store.connectionsUploadTotal = connections.uploadTotal;
  store.connectionsDownloadTotal = connections.downloadTotal;
}

export async function refreshProxies(): Promise<void> {
  setProxies((await api.getProxies()).proxies);
}

export async function refreshRules(): Promise<void> {
  store.rules = (await api.getRules()).rules;
}

export async function refreshProfiles(): Promise<void> {
  setProfiles(await api.getProfiles());
}

export async function refreshRuntimeState(): Promise<void> {
  const [status, profiles] = await Promise.all([api.getStatus(), api.getProfiles()]);
  store.status = status;
  setProfiles(profiles);
  store.daemonOnline = true;
  if (!status.core.running) {
    setProxies({});
    store.rules = [];
    return;
  }
  const [configs, proxies, rules] = await Promise.all([
    api.getConfigs(),
    api.getProxies(),
    api.getRules(),
  ]);
  store.mode = configs.mode;
  setProxies(proxies.proxies);
  store.rules = rules.rules;
}

/** Self-scheduling polling prevents overlapping requests and stale response rollback. */
export function startRuntimePolling(intervalMs = 2000): () => void {
  let stopped = false;
  let timer: number | null = null;
  let cycle = 0;

  const tick = async () => {
    try {
      await api.initialize();
      await refreshStatus();
      await refreshConnections().catch(() => undefined);
      cycle += 1;
      if (store.status?.core.running && cycle % 3 === 0) {
        await refreshProxies().catch(() => undefined);
      }
    } catch {
      store.daemonOnline = false;
    } finally {
      if (!stopped) timer = window.setTimeout(tick, intervalMs);
    }
  };

  void tick();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}

export function updateProxyDelay(name: string, delay: number): void {
  const item = store.proxies[name];
  if (!item) return;
  if (!item.history) item.history = [];
  item.history.push({ time: new Date().toISOString(), delay });
}

export function proxyDelay(name: string): number | undefined {
  const history = store.proxies[name]?.history ?? [];
  return history.at(-1)?.delay;
}

export function addTraffic(msg: TrafficMessage): void {
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
