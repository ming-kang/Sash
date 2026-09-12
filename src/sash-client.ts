import type { AutostartStatus } from "./autostart/contract.js";
import {
  type CoreStartResult,
  type CoreUpdateResponse,
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
  type RoutingMode,
  SashApiError,
  type SettingsPatch,
  type SettingsWriteResult,
  type SystemProxyStatusResponse,
  type WebBootstrapInfo,
  type WebSessionInfo,
} from "./contracts.js";
import { CORE_DELAY_REQUEST_MS, type CoreDelayResult } from "./core-delay.js";
import type { CoreUpdateProgress } from "./core-update.js";
import { type DaemonEvent, decodeDaemonEvents } from "./sash-events.js";
import type { PublicSashSettings } from "./settings.js";

export { SashApiError } from "./contracts.js";

/**
 * Browser-safe client for the daemon-owned /sash/* HTTP API. Response bodies are
 * typed by the daemon handlers of this installation; only error bodies are parsed.
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
  signal?: AbortSignal;
}

export type SashClientFetch = (
  url: string,
  init: SashClientFetchInit,
) => Promise<SashClientFetchResponse>;

export interface SashClientOptions {
  /** Origin or absolute base, e.g. "http://127.0.0.1:19090". Empty = same-origin. */
  baseUrl: string;
  /** Resolves the credential before every request (WebUI tokens arrive after authorization). */
  token?: () => string;
  /** Header carrying the credential; defaults to the CLI bearer. */
  tokenHeader?: "authorization" | "x-sash-token";
  fetchFn?: SashClientFetch;
  eventFetchFn?: SashEventFetch;
  /** Default per-request deadline. */
  timeoutMs?: number;
  /** Called when the daemon rejects the configured credential with 401. */
  onUnauthorized?: (token: string) => void;
}

export interface SashRequestOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  /** Honored only by retry-capable fetch adapters (the Node daemon client). */
  attempts?: number;
  /** Public credential exchanges must not send or invalidate a prior session. */
  authenticate?: boolean;
  signal?: AbortSignal;
}

const defaultFetch: SashClientFetch = async (url, init) => {
  const deadline = AbortSignal.timeout(init.timeoutMs ?? 5000);
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
  return { status: response.status, text: () => response.text() };
};

const CORE_OPERATION_TIMEOUT_MS = 20 * 60_000;

export class SashClient {
  private readonly baseUrl: string;
  private readonly token?: () => string;
  private readonly tokenHeader: "authorization" | "x-sash-token";
  private readonly fetchFn: SashClientFetch;
  private readonly eventFetchFn?: SashEventFetch;
  private readonly timeoutMs: number;
  private readonly onUnauthorized?: (token: string) => void;

  constructor(options: SashClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (options.token) this.token = options.token;
    this.tokenHeader = options.tokenHeader ?? "authorization";
    this.fetchFn = options.fetchFn ?? defaultFetch;
    this.eventFetchFn = options.eventFetchFn;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (options.onUnauthorized) this.onUnauthorized = options.onUnauthorized;
  }

  private async request<T>(endpoint: string, options: SashRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {};
    const token = options.authenticate === false ? "" : (this.token?.() ?? "");
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
      ...(options.signal ? { signal: options.signal } : {}),
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

    if (response.status === 401 && token) this.onUnauthorized?.(token);
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
    return data as T;
  }

  /* ---- daemon ---- */

  async health(): Promise<HealthInfo> {
    return this.request<HealthInfo>("/sash/daemon/health", {
      timeoutMs: 2_000,
      attempts: 1,
      authenticate: false,
    });
  }

  /** Authenticated CLI clients mint a one-time browser bootstrap token. */
  async createWebBootstrap(): Promise<WebBootstrapInfo> {
    return this.request<WebBootstrapInfo>("/sash/web/bootstrap", {
      method: "POST",
      timeoutMs: 5_000,
    });
  }

  /** Public exchange: redeem a one-time bootstrap token for a session token. */
  async redeemWebBootstrap(token: string): Promise<WebSessionInfo> {
    return this.request<WebSessionInfo>("/sash/web/session", {
      method: "POST",
      body: { token },
      timeoutMs: 5_000,
      attempts: 1,
      authenticate: false,
    });
  }

  async status(fresh = false): Promise<DaemonStatus> {
    return this.request<DaemonStatus>(
      fresh ? "/sash/daemon/status?fresh=1" : "/sash/daemon/status",
      {
        timeoutMs: 8000,
      },
    );
  }

  events(signal: AbortSignal): AsyncGenerator<DaemonEvent> {
    return readSashEvents({
      url: `${this.baseUrl}/sash/events`,
      token: this.token?.() ?? "",
      tokenHeader: this.tokenHeader,
      signal,
      fetchFn: this.eventFetchFn,
      onUnauthorized: this.onUnauthorized,
    });
  }

  async shutdown(): Promise<void> {
    await this.request("/sash/daemon/shutdown", { method: "POST", timeoutMs: 45_000 });
  }

  async autostartStatus(): Promise<AutostartStatus> {
    return this.request<AutostartStatus>("/sash/autostart", { timeoutMs: 15_000, attempts: 1 });
  }

  async setAutostart(enabled: boolean): Promise<AutostartStatus> {
    return this.request<AutostartStatus>("/sash/autostart", {
      method: "PUT",
      body: { enabled },
      timeoutMs: 60_000,
      attempts: 1,
    });
  }

  /* ---- core lifecycle ---- */

  async startCore(): Promise<CoreStartResult> {
    return this.request<CoreStartResult>("/sash/core/start", {
      method: "POST",
      timeoutMs: CORE_OPERATION_TIMEOUT_MS,
    });
  }

  async stopCore(): Promise<void> {
    await this.request("/sash/core/stop", { method: "POST", timeoutMs: 30_000 });
  }

  async restartCore(): Promise<CoreStartResult> {
    return this.request<CoreStartResult>("/sash/core/restart", {
      method: "POST",
      timeoutMs: CORE_OPERATION_TIMEOUT_MS,
    });
  }

  async updateCore(version?: string): Promise<CoreUpdateResponse> {
    return this.request<CoreUpdateResponse>("/sash/core/update", {
      method: "POST",
      body: version ? { version } : {},
      timeoutMs: CORE_OPERATION_TIMEOUT_MS,
    });
  }

  async coreUpdateProgress(): Promise<CoreUpdateProgress | null> {
    return this.request<CoreUpdateProgress | null>("/sash/core/update", {
      timeoutMs: 2000,
      attempts: 1,
    });
  }

  async testDelay(name: string, signal?: AbortSignal): Promise<CoreDelayResult> {
    return this.request<CoreDelayResult>("/sash/core/delay", {
      method: "POST",
      body: { name },
      timeoutMs: CORE_DELAY_REQUEST_MS + 2000,
      attempts: 1,
      signal,
    });
  }

  /* ---- system proxy ---- */

  async setMode(mode: RoutingMode): Promise<void> {
    await this.request("/sash/core/mode", { method: "PUT", body: { mode } });
  }

  async proxyStatus(fresh = false): Promise<SystemProxyStatusResponse> {
    return this.request<SystemProxyStatusResponse>(fresh ? "/sash/proxy?fresh=1" : "/sash/proxy");
  }

  /* ---- settings ---- */

  async getSettings(): Promise<PublicSashSettings> {
    return this.request<PublicSashSettings>("/sash/settings");
  }

  async patchSettings(patch: SettingsPatch): Promise<SettingsWriteResult> {
    return this.request<SettingsWriteResult>("/sash/settings", {
      method: "PATCH",
      body: patch,
      timeoutMs: 45_000,
    });
  }

  /* ---- profiles ---- */

  async listProfiles(): Promise<ProfilesIndex> {
    return this.request<ProfilesIndex>("/sash/profiles");
  }

  async reorderProfiles(ids: readonly string[]): Promise<ProfilesIndex> {
    return this.request<ProfilesIndex>("/sash/profiles/order", { method: "PUT", body: { ids } });
  }

  async addProfile(
    url: string,
    opts: { name?: string; activate?: boolean } = {},
  ): Promise<ProfileActionResponse> {
    return this.request<ProfileActionResponse>("/sash/profiles", {
      method: "POST",
      body: { url, ...opts },
      timeoutMs: 60_000,
    });
  }

  async importProfile(name: string, content: string): Promise<ProfileActionResponse> {
    return this.request<ProfileActionResponse>("/sash/profiles/import", {
      method: "POST",
      body: { name, content },
      timeoutMs: 30_000,
    });
  }

  async activateProfile(id: string | null): Promise<ProfileActivateResponse> {
    return this.request<ProfileActivateResponse>("/sash/profiles/active", {
      method: "PUT",
      body: { id },
      timeoutMs: 30_000,
    });
  }

  async updateProfile(id: string): Promise<ProfileUpdateResponse> {
    return this.request<ProfileUpdateResponse>(`/sash/profiles/${id}/update`, {
      method: "POST",
      timeoutMs: 60_000,
    });
  }

  async updateAllProfiles(): Promise<ProfilesUpdateAllResponse> {
    return this.request<ProfilesUpdateAllResponse>("/sash/profiles/update-all", {
      method: "POST",
      timeoutMs: 120_000,
    });
  }

  async getProfileContent(id: string): Promise<ProfileContentResponse> {
    return this.request<ProfileContentResponse>(`/sash/profiles/${id}/content`);
  }

  async writeProfileContent(
    id: string,
    content: string,
    revision: number,
  ): Promise<ProfileUpdateResponse> {
    return this.request<ProfileUpdateResponse>(`/sash/profiles/${id}/content`, {
      method: "PUT",
      body: { content, revision },
      timeoutMs: 30_000,
    });
  }

  async renameProfile(id: string, name: string): Promise<ProfileRenameResponse> {
    return this.request<ProfileRenameResponse>(`/sash/profiles/${id}`, {
      method: "PATCH",
      body: { name },
    });
  }

  async removeProfile(id: string): Promise<ProfileRemoveResponse> {
    return this.request<ProfileRemoveResponse>(`/sash/profiles/${id}`, {
      method: "DELETE",
      timeoutMs: 30_000,
    });
  }
}

export type SashEventFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  status: number;
  contentType: string;
  body: AsyncIterable<Uint8Array>;
}>;

const browserEventFetch: SashEventFetch = async (url, init) => {
  const response = await fetch(url, { ...init, redirect: "error" });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: {
      async *[Symbol.asyncIterator]() {
        const reader = response.body?.getReader();
        if (!reader) return;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      },
    },
  };
};

/** One stream attempt. Callers own reconnect policy and the lifetime of the subscription. */
export async function* readSashEvents(options: {
  url: string;
  token: string;
  tokenHeader: "authorization" | "x-sash-token";
  signal: AbortSignal;
  fetchFn?: SashEventFetch;
  onUnauthorized?: (token: string) => void;
}): AsyncGenerator<DaemonEvent> {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let timer = setTimeout(() => controller.abort(new Error("Daemon event headers timed out")), 8000);
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (options.token)
    headers[options.tokenHeader] =
      options.tokenHeader === "authorization" ? `Bearer ${options.token}` : options.token;
  try {
    const response = await (options.fetchFn ?? browserEventFetch)(options.url, { headers, signal });
    clearTimeout(timer);
    const touch = (): void => {
      clearTimeout(timer);
      timer = setTimeout(
        () => controller.abort(new Error("Daemon event stream stopped responding")),
        25_000,
      );
    };
    touch();
    if (response.status !== 200) {
      if (response.status === 401) options.onUnauthorized?.(options.token);
      let text = "";
      try {
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          text += decoder.decode(chunk, { stream: true });
          if (text.length >= 32_768) break;
        }
      } catch {
        /* Preserve the known HTTP status if the diagnostic body fails. */
      }
      let message = text.slice(0, 300).trim();
      let code: string | undefined;
      try {
        const error = parseApiErrorBody(JSON.parse(text));
        if (error) {
          message = error.message;
          code = error.code;
        }
      } catch {
        /* Plain HTTP diagnostics are also useful. */
      }
      throw new SashApiError(response.status, code, message || `HTTP ${response.status}`);
    }
    if (response.contentType.split(";")[0]?.trim().toLowerCase() !== "text/event-stream")
      throw new Error("Daemon did not return an event stream");
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for await (const chunk of response.body) {
        touch();
        yield chunk;
      }
    }
    let previous: DaemonEvent | undefined;
    for await (const event of decodeDaemonEvents(chunks())) {
      if (
        previous &&
        (event.status.daemon.bootId !== previous.status.daemon.bootId ||
          event.sequence <= previous.sequence)
      )
        throw new Error("Daemon event identity or sequence changed within a stream");
      previous = event;
      yield event;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
