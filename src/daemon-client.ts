import type {
  CoreStartResult,
  DaemonStatus,
  HealthInfo,
  ProfileActionResponse,
  ProfilesIndex,
  ProfilesUpdateAllResponse,
  ProfileUpdateResponse,
} from "./contracts.js";
import { ERROR_BODY_LIMIT, fetchWithRetry } from "./http.js";
import type { SystemProxyState } from "./sysproxy.js";

const DAEMON_SUCCESS_BODY_LIMIT = 1024 * 1024;

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
      deadlineMs?: number;
      attempts?: number;
      auth?: boolean;
    } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
    const headers: Record<string, string> = {};
    if (options.auth !== false && this.secret) headers.Authorization = `Bearer ${this.secret}`;
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
      // Leave undefined so fetchWithRetry's method-aware default applies.
      attempts: options.attempts,
      deadlineMs: options.deadlineMs ?? 5_000,
    });

    const text = await res.text(
      res.statusCode >= 200 && res.statusCode < 300 ? DAEMON_SUCCESS_BODY_LIMIT : ERROR_BODY_LIMIT,
    );
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
      deadlineMs: 2000,
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

  async status(fresh = false): Promise<DaemonStatus> {
    return this.request<DaemonStatus>(fresh ? "/sash/status?fresh=1" : "/sash/status");
  }

  async startCore(): Promise<CoreStartResult> {
    return this.request<CoreStartResult>("/core/start", { method: "POST", deadlineMs: 15_000 });
  }

  async stopCore(): Promise<void> {
    await this.request("/core/stop", { method: "POST", deadlineMs: 10_000 });
  }

  async restartCore(): Promise<CoreStartResult> {
    return this.request<CoreStartResult>("/core/restart", { method: "POST", deadlineMs: 15_000 });
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
      deadlineMs: 35_000,
    });
  }

  async updateProfile(id: string): Promise<ProfileUpdateResponse> {
    return this.request(`/sash/profiles/${id}/update`, { method: "POST", deadlineMs: 35_000 });
  }

  async updateAllProfiles(): Promise<ProfilesUpdateAllResponse> {
    return this.request("/sash/profiles/update-all", { method: "POST", deadlineMs: 120_000 });
  }

  async setActiveProfile(id: string | null): Promise<{ ok: boolean; proxyCount: number }> {
    return this.request<{ ok: boolean; proxyCount: number }>("/sash/profiles/active", {
      method: "PUT",
      body: { id },
      deadlineMs: 35_000,
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
        deadlineMs: 35_000,
      },
    );
  }

  async patchSetting(key: string, value?: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/sash/settings", {
      method: "PATCH",
      body: { key, value },
      deadlineMs: 15_000,
    });
  }

  async shutdown(): Promise<void> {
    try {
      await this.request("/sash/shutdown", { method: "POST", deadlineMs: 3000 });
    } catch {
      // Best effort; daemon may exit immediately.
    }
  }
}
