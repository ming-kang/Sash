import {
  type HealthInfo,
  type ProfileActionResponse,
  type ProfilesUpdateAllResponse,
  type ProfileUpdateResponse,
  WEB_SOCKET_AUTH_PROTOCOL,
  WEB_SOCKET_TOKEN_PROTOCOL_PREFIX,
} from "../../../src/contracts.js";
import type {
  ConfigsResponse,
  ConnectionsResponse,
  LogMessage,
  OutboundMode,
  ProfilesResponse,
  ProxiesResponse,
  RulesResponse,
  SashStatus,
  TrafficMessage,
} from "../types/index.js";
import { formatTime } from "../utils/format.js";

interface RequestOptions {
  method?: string;
  body?: unknown;
  response?: "json" | "void";
}

let controlToken = "";

async function request<T>(
  endpoint: string,
  options?: RequestOptions & { response?: "json" },
): Promise<T>;
async function request(
  endpoint: string,
  options: RequestOptions & { response: "void" },
): Promise<void>;
async function request(endpoint: string, options: RequestOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (controlToken) headers["X-Sash-Token"] = controlToken;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const res = await fetch(endpoint, {
    method: options.method ?? "GET",
    headers,
    body,
  });
  const text = await res.text();

  if (!res.ok) {
    let message = text.slice(0, 300).trim();
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (parsed.error !== undefined) message = String(parsed.error);
      } catch {
        // Keep the plain response text.
      }
    }
    throw new Error(message || `HTTP ${res.status}`);
  }

  if (options.response === "void") return undefined;
  if (!text) throw new Error(`Empty JSON response from ${endpoint}`);
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`Invalid JSON response from ${endpoint}: ${(err as Error).message}`);
  }
}

/** Persistent WebSocket with one reconnect timer. Returns an unsubscribe function. */
function connectStream<T>(
  path: string,
  onData: (msg: T) => void,
  onDisconnect?: () => void,
): () => void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}${path}`;
  let ws: WebSocket | null = null;
  let timer: number | null = null;
  let closed = false;

  const scheduleReconnect = () => {
    onDisconnect?.();
    if (closed || !controlToken || timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      connect();
    }, 3000);
  };

  const connect = () => {
    if (closed) return;
    try {
      const protocols = controlToken
        ? [WEB_SOCKET_AUTH_PROTOCOL, `${WEB_SOCKET_TOKEN_PROTOCOL_PREFIX}${controlToken}`]
        : undefined;
      ws = new WebSocket(wsUrl, protocols);
      ws.onmessage = (event) => {
        let parsed: T;
        try {
          parsed = JSON.parse(event.data) as T;
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
  initialize: async (): Promise<HealthInfo> => {
    try {
      const health = await request<HealthInfo>("/sash/health");
      controlToken = health.token;
      return health;
    } catch (err) {
      controlToken = "";
      throw err;
    }
  },
  clearSession: (): void => {
    controlToken = "";
  },
  hasSession: (): boolean => controlToken !== "",

  getHealth: () => request<HealthInfo>("/sash/health"),
  getStatus: () => request<SashStatus>("/sash/status"),

  enableSystemProxy: () =>
    request<{ ok: boolean; systemProxy: boolean }>("/sash/proxy/enable", { method: "POST" }),
  disableSystemProxy: () =>
    request<{ ok: boolean; systemProxy: boolean }>("/sash/proxy/disable", { method: "POST" }),

  getProfiles: () => request<ProfilesResponse>("/sash/profiles"),
  addProfile: (url: string) =>
    request<ProfileActionResponse>("/sash/profiles", { method: "POST", body: { url } }),
  importProfile: (name: string, content: string) =>
    request<ProfileActionResponse>("/sash/profiles/import", {
      method: "POST",
      body: { name, content },
    }),
  updateProfile: (id: string) =>
    request<ProfileUpdateResponse>(`/sash/profiles/${id}/update`, { method: "POST" }),
  updateAllProfiles: () =>
    request<ProfilesUpdateAllResponse>("/sash/profiles/update-all", { method: "POST" }),
  setActiveProfile: (id: string | null) =>
    request<{ ok: boolean; activeId: string | null; proxyCount: number }>("/sash/profiles/active", {
      method: "PUT",
      body: { id },
    }),
  deleteProfile: (id: string) =>
    request<{ ok: boolean; wasActive: boolean; proxyCount?: number }>(`/sash/profiles/${id}`, {
      method: "DELETE",
    }),

  patchSetting: (key: string, value: string) =>
    request<{ ok: boolean; settings: SashStatus["settings"] }>("/sash/settings", {
      method: "PATCH",
      body: { key, value },
    }),
  restartCore: () => request<{ ok: boolean; pid: number }>("/core/restart", { method: "POST" }),
  reloadCoreConfig: () =>
    request<{ ok: boolean; proxyCount: number }>("/core/config/reload", { method: "POST" }),

  getConfigs: () => request<ConfigsResponse>("/core/api/configs"),
  setMode: (mode: OutboundMode) =>
    request("/core/api/configs", { method: "PATCH", body: { mode }, response: "void" }),
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
    ),
  testGroupDelay: (
    groupName: string,
    url = "https://www.gstatic.com/generate_204",
    timeout = 5000,
  ) =>
    request<Record<string, number>>(
      `/core/api/group/${encodeURIComponent(groupName)}/delay?url=${encodeURIComponent(url)}&timeout=${timeout}`,
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
    connectStream<TrafficMessage>("/core/api/traffic", onData, onDisconnect),
  connectLogs: (onLog: (msg: LogMessage) => void) =>
    connectStream<LogMessage>("/core/api/logs", (msg) => {
      msg.time = formatTime();
      onLog(msg);
    }),
};
