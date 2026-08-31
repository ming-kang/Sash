import type { DaemonStatus } from "./daemon.js";
import { fetchWithRetry } from "./http.js";
import type { SystemProxyState } from "./sysproxy.js";

export interface HealthInfo {
  ok: boolean;
  token: string;
  pid: number;
  startedAt: string;
}

export interface CoreStartResult {
  ok: boolean;
  pid: number;
  version?: string;
}

export class SashDaemonClient {
  readonly baseUrl: string;
  private readonly secret: string;

  constructor(port: number, secret: string) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.secret = (secret || "").trim();
  }

  private async request(
    endpoint: string,
    options: {
      method?: string;
      body?: unknown;
      timeoutMs?: number;
      attempts?: number;
      auth?: boolean;
    } = {},
  ) {
    const url = `${this.baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
    const headers: Record<string, string> = {};
    if (options.auth !== false && this.secret) {
      headers.Authorization = `Bearer ${this.secret}`;
    }
    let bodyStr: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyStr = JSON.stringify(options.body);
    }

    const res = await fetchWithRetry(url, {
      method: options.method ?? "GET",
      headers,
      body: bodyStr,
      direct: true,
      attempts: options.attempts ?? 2,
      timeoutMs: options.timeoutMs ?? 5_000,
    });

    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      const msg =
        typeof data === "object" && data !== null && "error" in data
          ? String((data as { error: unknown }).error)
          : text.slice(0, 200).trim();
      throw new Error(`sashd returned HTTP ${res.statusCode}: ${msg || "unknown error"}`);
    }

    return data;
  }

  async health(): Promise<HealthInfo> {
    return (await this.request("/sash/health", {
      auth: false,
      attempts: 1,
      timeoutMs: 2000,
    })) as HealthInfo;
  }

  async isReachable(): Promise<boolean> {
    try {
      const h = await this.health();
      return Boolean(h?.ok);
    } catch {
      return false;
    }
  }

  async status(): Promise<DaemonStatus> {
    return (await this.request("/sash/status")) as DaemonStatus;
  }

  async startCore(): Promise<CoreStartResult> {
    return (await this.request("/core/start", {
      method: "POST",
      timeoutMs: 15_000,
      attempts: 1,
    })) as CoreStartResult;
  }

  async stopCore(): Promise<void> {
    await this.request("/core/stop", { method: "POST", timeoutMs: 10_000, attempts: 1 });
  }

  async restartCore(): Promise<CoreStartResult> {
    return (await this.request("/core/restart", {
      method: "POST",
      timeoutMs: 15_000,
      attempts: 1,
    })) as CoreStartResult;
  }

  async enableProxy(): Promise<{ ok: boolean; systemProxy: boolean }> {
    return (await this.request("/sash/proxy/enable", { method: "POST" })) as {
      ok: boolean;
      systemProxy: boolean;
    };
  }

  async disableProxy(): Promise<{ ok: boolean; systemProxy: boolean }> {
    return (await this.request("/sash/proxy/disable", { method: "POST" })) as {
      ok: boolean;
      systemProxy: boolean;
    };
  }

  async getProxy(): Promise<SystemProxyState & { desired: boolean; applied: boolean }> {
    return (await this.request("/sash/proxy")) as SystemProxyState & {
      desired: boolean;
      applied: boolean;
    };
  }

  async setSubscription(url: string): Promise<{ ok: boolean; proxyCount: number }> {
    return (await this.request("/sash/subscription", {
      method: "POST",
      body: { url },
      timeoutMs: 35_000,
      attempts: 1,
    })) as { ok: boolean; proxyCount: number };
  }

  async unsetSubscription(): Promise<void> {
    await this.request("/sash/subscription", { method: "DELETE" });
  }

  async refreshSubscription(): Promise<{ ok: boolean; proxyCount: number }> {
    return (await this.request("/sash/subscription/refresh", {
      method: "POST",
      timeoutMs: 35_000,
      attempts: 1,
    })) as { ok: boolean; proxyCount: number };
  }

  async reloadConfig(): Promise<{ ok: boolean; proxyCount: number; source: string }> {
    return (await this.request("/core/config/reload", {
      method: "POST",
      timeoutMs: 35_000,
      attempts: 1,
    })) as { ok: boolean; proxyCount: number; source: string };
  }

  async patchSetting(key: string, value?: string): Promise<{ ok: boolean }> {
    return (await this.request("/sash/settings", {
      method: "PATCH",
      body: { key, value },
      timeoutMs: 15_000,
      attempts: 1,
    })) as { ok: boolean };
  }

  async shutdown(): Promise<void> {
    try {
      await this.request("/sash/shutdown", { method: "POST", timeoutMs: 3000, attempts: 1 });
    } catch {
      // Best effort; daemon may exit immediately
    }
  }
}
