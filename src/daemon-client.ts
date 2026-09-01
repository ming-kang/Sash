import type {
  CoreStartResult,
  DaemonStatus,
  HealthInfo,
  ProfileActionResponse,
  ProfilesIndex,
  ProfilesUpdateAllResponse,
  ProfileUpdateResponse,
} from "./contracts.js";
import { fetchWithRetry } from "./http.js";
import type { SystemProxyState } from "./sysproxy.js";

export class SashDaemonClient {
  readonly baseUrl: string;
  private readonly secret: string;

  constructor(port: number, secret: string) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.secret = (secret || "").trim();
  }

  private async request<T = unknown>(
    endpoint: string,
    options: {
      method?: string;
      body?: unknown;
      timeoutMs?: number;
      attempts?: number;
      auth?: boolean;
    } = {},
  ): Promise<T> {
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
          : typeof data === "string"
            ? data.slice(0, 200).trim()
            : `HTTP ${res.statusCode}`;
      throw new Error(`sashd returned HTTP ${res.statusCode}: ${msg || "unknown error"}`);
    }

    return data as T;
  }

  async health(): Promise<HealthInfo> {
    return this.request<HealthInfo>("/sash/health", {
      auth: false,
      attempts: 1,
      timeoutMs: 2000,
    });
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
    return this.request<DaemonStatus>("/sash/status");
  }

  async startCore(): Promise<CoreStartResult> {
    return this.request<CoreStartResult>("/core/start", {
      method: "POST",
      timeoutMs: 15_000,
      attempts: 1,
    });
  }

  async stopCore(): Promise<void> {
    await this.request("/core/stop", { method: "POST", timeoutMs: 10_000, attempts: 1 });
  }

  async restartCore(): Promise<CoreStartResult> {
    return this.request<CoreStartResult>("/core/restart", {
      method: "POST",
      timeoutMs: 15_000,
      attempts: 1,
    });
  }

  async enableProxy(): Promise<{ ok: boolean; systemProxy: boolean }> {
    return this.request<{ ok: boolean; systemProxy: boolean }>("/sash/proxy/enable", {
      method: "POST",
    });
  }

  async disableProxy(): Promise<{ ok: boolean; systemProxy: boolean }> {
    return this.request<{ ok: boolean; systemProxy: boolean }>("/sash/proxy/disable", {
      method: "POST",
    });
  }

  async getProxy(): Promise<SystemProxyState & { desired: boolean; applied: boolean }> {
    return this.request<SystemProxyState & { desired: boolean; applied: boolean }>("/sash/proxy");
  }

  async getProfiles(): Promise<ProfilesIndex> {
    return this.request<ProfilesIndex>("/sash/profiles");
  }

  async addProfile(
    url: string,
    opts: { name?: string; activate?: boolean } = {},
  ): Promise<ProfileActionResponse> {
    return this.request("/sash/profiles", {
      method: "POST",
      body: { url, ...(opts.name ? { name: opts.name } : {}), activate: opts.activate === true },
      timeoutMs: 35_000,
      attempts: 1,
    });
  }

  async updateProfile(id: string): Promise<ProfileUpdateResponse> {
    return this.request(`/sash/profiles/${id}/update`, {
      method: "POST",
      timeoutMs: 35_000,
      attempts: 1,
    });
  }

  async updateAllProfiles(): Promise<ProfilesUpdateAllResponse> {
    return this.request("/sash/profiles/update-all", {
      method: "POST",
      timeoutMs: 120_000,
      attempts: 1,
    });
  }

  async setActiveProfile(id: string | null): Promise<{ ok: boolean; proxyCount: number }> {
    return this.request<{ ok: boolean; proxyCount: number }>("/sash/profiles/active", {
      method: "PUT",
      body: { id },
      timeoutMs: 35_000,
      attempts: 1,
    });
  }

  async deleteProfile(id: string): Promise<{ ok: boolean }> {
    return this.request(`/sash/profiles/${id}`, { method: "DELETE" });
  }

  async reloadConfig(): Promise<{ ok: boolean; proxyCount: number; source: string }> {
    return this.request<{ ok: boolean; proxyCount: number; source: string }>(
      "/core/config/reload",
      {
        method: "POST",
        timeoutMs: 35_000,
        attempts: 1,
      },
    );
  }

  async patchSetting(key: string, value?: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/sash/settings", {
      method: "PATCH",
      body: { key, value },
      timeoutMs: 15_000,
      attempts: 1,
    });
  }

  async shutdown(): Promise<void> {
    try {
      await this.request("/sash/shutdown", { method: "POST", timeoutMs: 3000, attempts: 1 });
    } catch {
      // Best effort; daemon may exit immediately
    }
  }
}
