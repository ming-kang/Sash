import {
  type CoreStartResult,
  type DaemonStatus,
  type HealthInfo,
  type MaintenanceShutdownResult,
  parseDaemonStatus,
  parseHealthInfo,
} from "./contracts.js";
import { ERROR_BODY_LIMIT, fetchWithRetry } from "./http.js";

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
    return parseHealthInfo(
      await this.request("/sash/health", {
        auth: false,
        attempts: 1,
        deadlineMs: 2000,
      }),
    );
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
    return parseDaemonStatus(await this.request(fresh ? "/sash/status?fresh=1" : "/sash/status"));
  }

  async startCore(): Promise<CoreStartResult> {
    return this.request<CoreStartResult>("/core/start", { method: "POST", deadlineMs: 15_000 });
  }

  async maintenanceShutdown(): Promise<MaintenanceShutdownResult> {
    return this.request<MaintenanceShutdownResult>("/sash/maintenance/shutdown", {
      method: "POST",
      deadlineMs: 45_000,
    });
  }

  async shutdown(): Promise<void> {
    // The daemon sends its success response before closing its listener. A
    // response error is therefore a real cleanup failure, not best effort.
    await this.request("/sash/shutdown", { method: "POST", deadlineMs: 45_000 });
  }
}
