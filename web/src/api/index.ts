import type {
  ConfigsResponse,
  ConnectionsResponse,
  LogMessage,
  OutboundMode,
  ProfileMeta,
  ProfilesResponse,
  ProxiesResponse,
  RulesResponse,
  SashStatus,
  TrafficMessage,
} from "../types/index.js";
import { formatTime } from "../utils/format.js";

async function request<T>(
  endpoint: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  let bodyStr: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(options.body);
  }

  const res = await fetch(endpoint, {
    method: options.method ?? "GET",
    headers,
    body: bodyStr,
  });

  if (!res.ok) {
    let errText = "";
    try {
      const json = await res.json();
      errText = json.error || JSON.stringify(json);
    } catch {
      errText = await res.text().catch(() => "");
    }
    throw new Error(errText || `HTTP ${res.status}`);
  }

  // Several core endpoints (PATCH /configs, PUT /proxies/:name, DELETE
  // /connections…) answer 204 with an empty body; res.json() would throw.
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** Persistent WebSocket with auto-reconnect. Returns an unsubscribe function. */
function connectStream<T>(path: string, onData: (msg: T) => void): () => void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}${path}`;
  let ws: WebSocket | null = null;
  let timer: number | null = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (event) => {
        try {
          onData(JSON.parse(event.data) as T);
        } catch {
          // malformed frame, ignore
        }
      };
      ws.onclose = () => {
        if (!closed) timer = window.setTimeout(connect, 3000);
      };
      ws.onerror = () => ws?.close();
    } catch {
      if (!closed) timer = window.setTimeout(connect, 3000);
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
  /* /sash/* ------------------------------------------------------------- */

  getHealth: () => request<{ ok: boolean; token: string; pid: number }>("/sash/health"),

  getStatus: () => request<SashStatus>("/sash/status"),

  enableSystemProxy: () =>
    request<{ ok: boolean; systemProxy: boolean }>("/sash/proxy/enable", { method: "POST" }),

  disableSystemProxy: () =>
    request<{ ok: boolean; systemProxy: boolean }>("/sash/proxy/disable", { method: "POST" }),

  getProfiles: () => request<ProfilesResponse>("/sash/profiles"),

  addProfile: (url: string) =>
    request<{ ok: boolean; profile: ProfileMeta; activated: boolean; proxyCount?: number }>(
      "/sash/profiles",
      { method: "POST", body: { url } },
    ),

  importProfile: (name: string, content: string) =>
    request<{ ok: boolean; profile: ProfileMeta; activated: boolean; proxyCount?: number }>(
      "/sash/profiles/import",
      { method: "POST", body: { name, content } },
    ),

  updateProfile: (id: string) =>
    request<{ ok: boolean; proxyCount?: number }>(`/sash/profiles/${id}/update`, {
      method: "POST",
    }),

  updateAllProfiles: () =>
    request<{
      ok: boolean;
      updated: number;
      failed: Array<{ id: string; name: string; error: string }>;
      proxyCount?: number;
    }>("/sash/profiles/update-all", { method: "POST" }),

  setActiveProfile: (id: string | null) =>
    request<{ ok: boolean; activeId: string | null; proxyCount: number }>(
      "/sash/profiles/active",
      { method: "PUT", body: { id } },
    ),

  deleteProfile: (id: string) =>
    request<{ ok: boolean; wasActive: boolean; proxyCount?: number }>(`/sash/profiles/${id}`, {
      method: "DELETE",
    }),

  patchSetting: (key: string, value: string) =>
    request<{ ok: boolean }>("/sash/settings", { method: "PATCH", body: { key, value } }),

  restartCore: () => request<{ ok: boolean; pid: number }>("/core/restart", { method: "POST" }),

  reloadCoreConfig: () =>
    request<{ ok: boolean; proxyCount: number }>("/core/config/reload", { method: "POST" }),

  /* /core/api/* ---------------------------------------------------------- */

  getConfigs: () => request<ConfigsResponse>("/core/api/configs"),

  setMode: (mode: OutboundMode) =>
    request<void>("/core/api/configs", { method: "PATCH", body: { mode } }),

  getProxies: () => request<ProxiesResponse>("/core/api/proxies"),

  selectProxy: (groupName: string, proxyName: string) =>
    request<void>(`/core/api/proxies/${encodeURIComponent(groupName)}`, {
      method: "PUT",
      body: { name: proxyName },
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
    request<void>(`/core/api/connections/${encodeURIComponent(id)}`, { method: "DELETE" }),

  closeAllConnections: () => request<void>("/core/api/connections", { method: "DELETE" }),

  getRules: () => request<RulesResponse>("/core/api/rules"),

  /* WebSocket streams ----------------------------------------------------- */

  connectTraffic: (onData: (msg: TrafficMessage) => void) =>
    connectStream<TrafficMessage>("/core/api/traffic", onData),

  connectLogs: (onLog: (msg: LogMessage) => void) =>
    connectStream<LogMessage>("/core/api/logs", (msg) => {
      msg.time = formatTime();
      onLog(msg);
    }),
};
