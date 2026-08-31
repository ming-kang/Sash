import type {
  ConfigsResponse,
  ConnectionsResponse,
  LogMessage,
  OutboundMode,
  ProxiesResponse,
  RulesResponse,
  SashStatus,
  TrafficMessage,
} from "../types/index.js";

export class ApiClient {
  private async request<T>(
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
        errText = await res.text();
      }
      throw new Error(errText || `HTTP ${res.status}`);
    }

    return res.json() as Promise<T>;
  }

  /* ======================================================================== */
  /* /sash/*                                                                  */
  /* ======================================================================== */

  async getHealth(): Promise<{ ok: boolean; token: string; pid: number }> {
    return this.request<{ ok: boolean; token: string; pid: number }>("/sash/health");
  }

  async getStatus(): Promise<SashStatus> {
    return this.request<SashStatus>("/sash/status");
  }

  async enableSystemProxy(): Promise<{ ok: boolean; systemProxy: boolean }> {
    return this.request<{ ok: boolean; systemProxy: boolean }>("/sash/proxy/enable", {
      method: "POST",
    });
  }

  async disableSystemProxy(): Promise<{ ok: boolean; systemProxy: boolean }> {
    return this.request<{ ok: boolean; systemProxy: boolean }>("/sash/proxy/disable", {
      method: "POST",
    });
  }

  async setSubscription(url: string): Promise<{ ok: boolean; proxyCount: number }> {
    return this.request<{ ok: boolean; proxyCount: number }>("/sash/subscription", {
      method: "POST",
      body: { url },
    });
  }

  async refreshSubscription(): Promise<{ ok: boolean; proxyCount: number }> {
    return this.request<{ ok: boolean; proxyCount: number }>("/sash/subscription/refresh", {
      method: "POST",
    });
  }

  async unsetSubscription(): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/sash/subscription", {
      method: "DELETE",
    });
  }

  async patchSetting(key: string, value: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/sash/settings", {
      method: "PATCH",
      body: { key, value },
    });
  }

  async restartCore(): Promise<{ ok: boolean; pid: number }> {
    return this.request<{ ok: boolean; pid: number }>("/core/restart", {
      method: "POST",
    });
  }

  async reloadCoreConfig(): Promise<{ ok: boolean; proxyCount: number }> {
    return this.request<{ ok: boolean; proxyCount: number }>("/core/config/reload", {
      method: "POST",
    });
  }

  /* ======================================================================== */
  /* /core/api/*                                                              */
  /* ======================================================================== */

  async getConfigs(): Promise<ConfigsResponse> {
    return this.request<ConfigsResponse>("/core/api/configs");
  }

  async setMode(mode: OutboundMode): Promise<void> {
    await this.request("/core/api/configs", {
      method: "PATCH",
      body: { mode },
    });
  }

  async getProxies(): Promise<ProxiesResponse> {
    return this.request<ProxiesResponse>("/core/api/proxies");
  }

  async selectProxy(groupName: string, proxyName: string): Promise<void> {
    await this.request(`/core/api/proxies/${encodeURIComponent(groupName)}`, {
      method: "PUT",
      body: { name: proxyName },
    });
  }

  async testProxyDelay(
    proxyName: string,
    url = "https://www.gstatic.com/generate_204",
    timeout = 5000,
  ): Promise<{ delay: number }> {
    return this.request<{ delay: number }>(
      `/core/api/proxies/${encodeURIComponent(proxyName)}/delay?url=${encodeURIComponent(url)}&timeout=${timeout}`,
    );
  }

  async getConnections(): Promise<ConnectionsResponse> {
    return this.request<ConnectionsResponse>("/core/api/connections");
  }

  async closeConnection(id: string): Promise<void> {
    await this.request(`/core/api/connections/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async closeAllConnections(): Promise<void> {
    await this.request("/core/api/connections", {
      method: "DELETE",
    });
  }

  async getRules(): Promise<RulesResponse> {
    return this.request<RulesResponse>("/core/api/rules");
  }

  /* ======================================================================== */
  /* WebSocket Streams                                                        */
  /* ======================================================================== */

  connectTrafficStream(onData: (msg: TrafficMessage) => void): () => void {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/core/api/traffic`;
    let ws: WebSocket | null = null;
    let timer: number | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(wsUrl);
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data) as TrafficMessage;
            onData(data);
          } catch {
            // ignore
          }
        };
        ws.onclose = () => {
          if (!closed) timer = window.setTimeout(connect, 3000);
        };
        ws.onerror = () => {
          ws?.close();
        };
      } catch {
        if (!closed) timer = window.setTimeout(connect, 3000);
      }
    };

    connect();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (ws) ws.close();
    };
  }

  connectLogsStream(onLog: (msg: LogMessage) => void): () => void {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/core/api/logs`;
    let ws: WebSocket | null = null;
    let timer: number | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(wsUrl);
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data) as LogMessage;
            data.time = new Date().toLocaleTimeString();
            onLog(data);
          } catch {
            // ignore
          }
        };
        ws.onclose = () => {
          if (!closed) timer = window.setTimeout(connect, 3000);
        };
        ws.onerror = () => {
          ws?.close();
        };
      } catch {
        if (!closed) timer = window.setTimeout(connect, 3000);
      }
    };

    connect();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (ws) ws.close();
    };
  }
}

export const api = new ApiClient();
