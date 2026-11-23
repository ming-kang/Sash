import type { SettingsPatch } from "../../../src/contracts.js";
import { browserEventFetch, browserFetch, SashClient } from "../../../src/sash-client.js";
import type {
  ConfigsResponse,
  ConnectionsResponse,
  LogMessage,
  ProxiesResponse,
  RoutingMode,
  RulesResponse,
  TrafficMessage,
} from "../types/index.js";
import { formatTime } from "../utils/format.js";

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseTrafficFrame(value: unknown): TrafficMessage | null {
  const frame = objectRecord(value);
  if (!frame) return null;
  const { up, down } = frame;
  if (
    typeof up !== "number" ||
    !Number.isFinite(up) ||
    up < 0 ||
    typeof down !== "number" ||
    !Number.isFinite(down) ||
    down < 0
  )
    return null;
  return { up, down };
}

const LOG_TYPES = new Set<LogMessage["type"]>(["info", "warning", "error", "debug"]);

function parseLogFrame(value: unknown): LogMessage | null {
  const frame = objectRecord(value);
  if (!frame || typeof frame.type !== "string" || typeof frame.payload !== "string") return null;
  if (!LOG_TYPES.has(frame.type as LogMessage["type"])) return null;
  return { type: frame.type as LogMessage["type"], payload: frame.payload };
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  response?: "json" | "void";
  timeoutMs?: number;
}

// No credential: Sash admits requests the browser marks as coming from its own origin.
const sash = new SashClient({
  baseUrl: "",
  fetchFn: browserFetch,
  eventFetchFn: browserEventFetch,
});

async function request<T>(
  endpoint: string,
  options?: RequestOptions & { response?: "json" },
): Promise<T>;
async function request(
  endpoint: string,
  options: RequestOptions & { response: "void" },
): Promise<void>;
async function request(endpoint: string, options: RequestOptions = {}): Promise<unknown> {
  const result = await sash.rawRequest<unknown>(endpoint, {
    method: options.method,
    body: options.body,
    timeoutMs: options.timeoutMs ?? 10_000,
  });
  if (options.response === "void") return undefined;
  if (result === undefined) throw new Error(`Empty JSON response from ${endpoint}`);
  return result;
}

function connectStream(
  path: string,
  onData: (msg: unknown) => void,
  onDisconnect?: () => void,
): () => void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}${path}`;
  let ws: WebSocket | null = null;
  let timer: number | null = null;
  let closed = false;

  const scheduleReconnect = () => {
    if (closed) return;
    onDisconnect?.();
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      connect();
    }, 3000);
  };

  const connect = () => {
    if (closed) return;
    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (event) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data) as unknown;
        } catch {
          return;
        }
        onData(parsed);
      };
      ws.onclose = () => {
        ws = null;
        scheduleReconnect();
      };
      ws.onerror = () => ws?.close();
    } catch {
      scheduleReconnect();
    }
  };

  connect();

  return () => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    ws?.close();
  };
}

export const api = {
  getHealth: () => sash.health(),
  getStatus: () => sash.status(),
  events: (signal: AbortSignal) => sash.events(signal),
  getAutostart: () => sash.autostartStatus(),
  setAutostart: (enabled: boolean) => sash.setAutostart(enabled),

  enableSystemProxy: (expectedRevision?: number) =>
    sash.patchSettings({ systemProxy: true, expectedRevision }),
  disableSystemProxy: (expectedRevision?: number) =>
    sash.patchSettings({ systemProxy: false, expectedRevision }),

  getProfiles: () => sash.listProfiles(),
  reorderProfiles: (ids: readonly string[]) => sash.reorderProfiles(ids),
  addProfile: (url: string) => sash.addProfile(url),
  importProfile: (name: string, content: string) => sash.importProfile(name, content),
  updateProfile: (id: string) => sash.updateProfile(id),
  updateAllProfiles: () => sash.updateAllProfiles(),
  setActiveProfile: (id: string | null) => sash.activateProfile(id),
  deleteProfile: (id: string) => sash.removeProfile(id),
  renameProfile: (id: string, name: string) => sash.renameProfile(id, name),
  getProfileContent: (id: string) => sash.getProfileContent(id),
  setProfileContent: (id: string, content: string, revision: number) =>
    sash.writeProfileContent(id, content, revision),

  patchSettings: (patch: SettingsPatch) => sash.patchSettings(patch),
  restartCore: () => sash.restartCore(),
  stopCore: () => sash.stopCore(),
  updateCore: () => sash.updateCore(),
  cancelCoreUpdate: () => sash.cancelCoreUpdate(),
  checkCoreUpdate: () => sash.checkCoreUpdate(),

  getConfigs: () => request<ConfigsResponse>("/core/api/configs"),
  setMode: (mode: RoutingMode) => sash.setMode(mode),
  getProxies: () => request<ProxiesResponse>("/core/api/proxies"),
  selectProxy: (groupName: string, proxyName: string) =>
    request(`/core/api/proxies/${encodeURIComponent(groupName)}`, {
      method: "PUT",
      body: { name: proxyName },
      response: "void",
    }),
  testProxyDelay: (
    proxyName: string,
    url = "https://www.gstatic.com/generate_204",
    timeout = 5000,
  ) =>
    request<{ delay: number }>(
      `/core/api/proxies/${encodeURIComponent(proxyName)}/delay?url=${encodeURIComponent(url)}&timeout=${timeout}`,
      { timeoutMs: Math.max(10_000, timeout + 5_000) },
    ),
  testGroupDelay: (
    groupName: string,
    url = "https://www.gstatic.com/generate_204",
    timeout = 5000,
  ) =>
    request<Record<string, number>>(
      `/core/api/group/${encodeURIComponent(groupName)}/delay?url=${encodeURIComponent(url)}&timeout=${timeout}`,
      { timeoutMs: Math.max(60_000, timeout + 5_000) },
    ),
  getConnections: () => request<ConnectionsResponse>("/core/api/connections"),
  closeConnection: (id: string) =>
    request(`/core/api/connections/${encodeURIComponent(id)}`, {
      method: "DELETE",
      response: "void",
    }),
  closeAllConnections: () =>
    request("/core/api/connections", { method: "DELETE", response: "void" }),
  getRules: () => request<RulesResponse>("/core/api/rules"),

  connectTraffic: (onData: (msg: TrafficMessage) => void, onDisconnect?: () => void) =>
    connectStream(
      "/core/api/traffic",
      (value) => {
        const message = parseTrafficFrame(value);
        if (message) onData(message);
      },
      onDisconnect,
    ),
  connectLogs: (onLog: (msg: LogMessage) => void) =>
    connectStream("/core/api/logs", (value) => {
      const message = parseLogFrame(value);
      if (message) onLog({ ...message, time: formatTime() });
    }),
};
