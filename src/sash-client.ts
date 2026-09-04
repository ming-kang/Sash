import {
  type CoreReloadResult,
  type CoreStartResult,
  type DaemonStatus,
  type HealthInfo,
  type ProfileActionResponse,
  type ProfileActivateResponse,
  type ProfileContentResponse,
  type ProfileRemoveResponse,
  type ProfileRenameResponse,
  type ProfilesIndex,
  type ProfilesUpdateAllResponse,
  type ProfileUpdateResponse,
  parseApiErrorBody,
  parseCoreReloadResult,
  parseCoreStartResult,
  parseDaemonStatus,
  parseHealthInfo,
  parseProfileActionResponse,
  parseProfileActivateResponse,
  parseProfileContentResponse,
  parseProfileRemoveResponse,
  parseProfileRenameResponse,
  parseProfilesIndex,
  parseProfilesUpdateAllResponse,
  parseProfileUpdateResponse,
  parsePublicSettings,
  parseSettingsFileContent,
  parseSettingsWriteResult,
  parseShutdownResult,
  parseSystemProxyStatusResponse,
  type SettingsFileContent,
  type SettingsPatch,
  type SettingsWriteResult,
  type ShutdownResult,
  type SystemProxyStatusResponse,
} from "./contracts.js";
import type { PublicSashSettings } from "./settings.js";

/**
 * Browser-safe client for the daemon-owned /sash/* HTTP API. Every response
 * body is validated by a contracts parser before it reaches the caller.
 */

export interface SashClientFetchResponse {
  status: number;
  text(): Promise<string>;
}

export interface SashClientFetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** Client-side deadline; the fetch adapter translates it as it sees fit. */
  timeoutMs?: number;
  /** Honored only by retry-capable fetch adapters (the Node daemon client). */
  attempts?: number;
}

export type SashClientFetch = (
  url: string,
  init: SashClientFetchInit,
) => Promise<SashClientFetchResponse>;

export interface SashClientOptions {
  /** Origin or absolute base, e.g. "http://127.0.0.1:19090". Empty = same-origin. */
  baseUrl: string;
  /** Resolves the credential before every request (the WebUI token arrives after health). */
  token?: () => string;
  /** Header carrying the credential; defaults to the CLI bearer. */
  tokenHeader?: "authorization" | "x-sash-token";
  fetchFn?: SashClientFetch;
  /** Default per-request deadline. */
  timeoutMs?: number;
}

export interface SashRequestOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  /** Honored only by retry-capable fetch adapters (the Node daemon client). */
  attempts?: number;
}

const defaultFetch: SashClientFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    ...(init.timeoutMs !== undefined ? { signal: AbortSignal.timeout(init.timeoutMs) } : {}),
  });
  return { status: response.status, text: () => response.text() };
};

/** HTTP failure from the daemon API, carrying the error-envelope fields. */
export class SashApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "SashApiError";
  }
}

export class SashClient {
  private readonly baseUrl: string;
  private readonly token?: () => string;
  private readonly tokenHeader: "authorization" | "x-sash-token";
  private readonly fetchFn: SashClientFetch;
  private readonly timeoutMs: number;

  constructor(options: SashClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (options.token) this.token = options.token;
    this.tokenHeader = options.tokenHeader ?? "authorization";
    this.fetchFn = options.fetchFn ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  private async request(endpoint: string, options: SashRequestOptions = {}): Promise<unknown> {
    const headers: Record<string, string> = {};
    const token = this.token?.() ?? "";
    if (token) {
      if (this.tokenHeader === "x-sash-token") headers["X-Sash-Token"] = token;
      else headers.Authorization = `Bearer ${token}`;
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const response = await this.fetchFn(`${this.baseUrl}${endpoint}`, {
      method: options.method ?? "GET",
      headers,
      ...(body !== undefined ? { body } : {}),
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
    });
    const text = await response.text();

    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch (err) {
      if (response.status >= 200 && response.status < 300) {
        throw new Error(`Invalid JSON response from ${endpoint}: ${(err as Error).message}`);
      }
      data = text;
    }

    if (response.status < 200 || response.status >= 300) {
      const parsedError = parseApiErrorBody(data);
      const message =
        parsedError?.message ?? (typeof data === "string" ? data.slice(0, 300).trim() : "");
      throw new SashApiError(
        response.status,
        parsedError?.code,
        message || `HTTP ${response.status}`,
      );
    }
    return data;
  }

  /* ---- daemon ---- */

  async health(): Promise<HealthInfo> {
    return parseHealthInfo(
      await this.request("/sash/daemon/health", { timeoutMs: 2_000, attempts: 1 }),
    );
  }

  async status(fresh = false): Promise<DaemonStatus> {
    return parseDaemonStatus(
      await this.request(fresh ? "/sash/daemon/status?fresh=1" : "/sash/daemon/status"),
    );
  }

  /** Cleanup completes before the daemon acknowledges; the listener closes after the response. */
  async shutdown(): Promise<ShutdownResult> {
    return parseShutdownResult(
      await this.request("/sash/daemon/shutdown", { method: "POST", timeoutMs: 45_000 }),
    );
  }

  /* ---- core lifecycle ---- */

  async startCore(): Promise<CoreStartResult> {
    return parseCoreStartResult(
      await this.request("/sash/core/start", { method: "POST", timeoutMs: 15_000 }),
    );
  }

  async stopCore(): Promise<void> {
    await this.request("/sash/core/stop", { method: "POST", timeoutMs: 30_000 });
  }

  async restartCore(): Promise<CoreStartResult> {
    return parseCoreStartResult(
      await this.request("/sash/core/restart", { method: "POST", timeoutMs: 30_000 }),
    );
  }

  async reloadCoreConfig(): Promise<CoreReloadResult> {
    return parseCoreReloadResult(
      await this.request("/sash/core/reload", { method: "POST", timeoutMs: 30_000 }),
    );
  }

  /* ---- system proxy ---- */

  async proxyStatus(fresh = false): Promise<SystemProxyStatusResponse> {
    return parseSystemProxyStatusResponse(
      await this.request(fresh ? "/sash/proxy?fresh=1" : "/sash/proxy"),
    );
  }

  /* ---- settings ---- */

  async getSettings(): Promise<PublicSashSettings> {
    return parsePublicSettings(await this.request("/sash/settings"));
  }

  async patchSettings(patch: SettingsPatch): Promise<SettingsWriteResult> {
    return parseSettingsWriteResult(
      await this.request("/sash/settings", { method: "PATCH", body: patch, timeoutMs: 45_000 }),
    );
  }

  async getSettingsFile(): Promise<SettingsFileContent> {
    return parseSettingsFileContent(await this.request("/sash/settings/file"));
  }

  async writeSettingsFile(content: string): Promise<SettingsWriteResult> {
    return parseSettingsWriteResult(
      await this.request("/sash/settings/file", {
        method: "PUT",
        body: { content },
        timeoutMs: 45_000,
      }),
    );
  }

  /* ---- profiles ---- */

  async listProfiles(): Promise<ProfilesIndex> {
    return parseProfilesIndex(await this.request("/sash/profiles"));
  }

  async addProfile(
    url: string,
    opts: { name?: string; activate?: boolean } = {},
  ): Promise<ProfileActionResponse> {
    return parseProfileActionResponse(
      await this.request("/sash/profiles", {
        method: "POST",
        body: { url, ...opts },
        timeoutMs: 60_000,
      }),
    );
  }

  async importProfile(name: string, content: string): Promise<ProfileActionResponse> {
    return parseProfileActionResponse(
      await this.request("/sash/profiles/import", {
        method: "POST",
        body: { name, content },
        timeoutMs: 30_000,
      }),
    );
  }

  async activateProfile(id: string | null): Promise<ProfileActivateResponse> {
    return parseProfileActivateResponse(
      await this.request("/sash/profiles/active", {
        method: "PUT",
        body: { id },
        timeoutMs: 30_000,
      }),
    );
  }

  async updateProfile(id: string): Promise<ProfileUpdateResponse> {
    return parseProfileUpdateResponse(
      await this.request(`/sash/profiles/${id}/update`, {
        method: "POST",
        timeoutMs: 60_000,
      }),
    );
  }

  async updateAllProfiles(): Promise<ProfilesUpdateAllResponse> {
    return parseProfilesUpdateAllResponse(
      await this.request("/sash/profiles/update-all", { method: "POST", timeoutMs: 120_000 }),
    );
  }

  async getProfileContent(id: string): Promise<ProfileContentResponse> {
    return parseProfileContentResponse(await this.request(`/sash/profiles/${id}/content`));
  }

  async writeProfileContent(id: string, content: string): Promise<ProfileUpdateResponse> {
    return parseProfileUpdateResponse(
      await this.request(`/sash/profiles/${id}/content`, {
        method: "PUT",
        body: { content },
        timeoutMs: 30_000,
      }),
    );
  }

  async renameProfile(id: string, name: string): Promise<ProfileRenameResponse> {
    return parseProfileRenameResponse(
      await this.request(`/sash/profiles/${id}`, { method: "PATCH", body: { name } }),
    );
  }

  async removeProfile(id: string): Promise<ProfileRemoveResponse> {
    return parseProfileRemoveResponse(
      await this.request(`/sash/profiles/${id}`, { method: "DELETE", timeoutMs: 30_000 }),
    );
  }
}
