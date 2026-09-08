import { fetchWithRetry, readErrorSummary } from "./http.js";
import { parseControllerAddress } from "./settings.js";

/**
 * Low-level Mihomo external-controller client used internally by the
 * daemon supervisor to check Core health and update routing mode.
 *
 * All requests use direct dispatching so local loopback traffic is never
 * intercepted by HTTP_PROXY or other environment proxy settings.
 */
export class MihomoApi {
  readonly baseUrl: string;
  private readonly secret: string;

  constructor(controller: string, secret: string) {
    const raw = controller.trim() || "127.0.0.1:9090";
    const address = parseControllerAddress(raw);
    if (!address) {
      throw new Error(`Invalid controller address: ${raw} (expected loopback host:port)`);
    }
    this.baseUrl = `http://${address.canonical}`;
    this.secret = (secret || "").trim();
  }

  private async request(
    endpoint: string,
    options: {
      method?: string;
      body?: string;
      deadlineMs?: number;
      attempts?: number;
    } = {},
  ) {
    const url = `${this.baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
    const headers: Record<string, string> = {};
    if (this.secret) headers.Authorization = `Bearer ${this.secret}`;
    if (options.body) headers["Content-Type"] = "application/json";
    return fetchWithRetry(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body,
      direct: true,
      manualRedirect: true,
      attempts: options.attempts,
      deadlineMs: options.deadlineMs ?? 5_000,
    });
  }

  async isReachable(): Promise<boolean> {
    try {
      return Boolean(await this.version());
    } catch {
      return false;
    }
  }

  async version(options: { deadlineMs?: number; attempts?: number } = {}): Promise<string> {
    const res = await this.request("/version", {
      deadlineMs: options.deadlineMs ?? 5_000,
      attempts: options.attempts ?? 2,
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const summary = await readErrorSummary(res);
      throw new Error(`Mihomo API returned HTTP ${res.statusCode}: ${summary}`);
    }
    const text = await res.text(1024 * 1024);
    let data: { version?: unknown; meta?: unknown };
    try {
      data = JSON.parse(text) as { version?: unknown; meta?: unknown };
    } catch {
      throw new Error(`Invalid JSON response from Mihomo /version: ${text.slice(0, 200).trim()}`);
    }
    if (typeof data.version === "string" && data.version.trim()) return data.version.trim();
    throw new Error("Mihomo /version response is missing a non-empty version");
  }
  async setMode(mode: "rule" | "global" | "direct"): Promise<void> {
    const response = await this.request("/configs", {
      method: "PATCH",
      body: JSON.stringify({ mode }),
      attempts: 1,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const message = await readErrorSummary(response);
      throw new Error(`Core rejected mode change: HTTP ${response.statusCode}: ${message}`);
    }
    await response.discard();
  }

  async runtimeState(): Promise<CoreRuntimeState> {
    const read = async (endpoint: string): Promise<unknown> => {
      const response = await this.request(endpoint, { attempts: 1 });
      if (response.statusCode !== 200) {
        await response.discard();
        throw new Error(
          `Cannot capture Core runtime: ${endpoint} returned HTTP ${response.statusCode}`,
        );
      }
      try {
        return JSON.parse(await response.text(8 * 1024 * 1024)) as unknown;
      } catch {
        throw new Error(`Cannot parse Core runtime response: ${endpoint}`);
      }
    };
    const [config, proxies] = await Promise.all([read("/configs"), read("/proxies")]);
    return captureCoreRuntimeState(config, proxies);
  }

  async restoreRuntimeState(state: CoreRuntimeState): Promise<void> {
    await this.setMode(state.mode);
    for (const [group, name] of Object.entries(state.selections)) {
      const response = await this.request(`/proxies/${encodeURIComponent(group)}`, {
        method: "PUT",
        body: JSON.stringify({ name }),
        attempts: 1,
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        await response.discard();
        throw new Error(`Cannot restore Core selection: HTTP ${response.statusCode}`);
      }
      await response.discard();
    }
    const actual = await this.runtimeState();
    if (
      actual.mode !== state.mode ||
      Object.entries(state.selections).some(([group, name]) => actual.selections[group] !== name)
    )
      throw new Error("Core runtime verification failed after restoration");
  }
}

import { type CoreRuntimeState, captureCoreRuntimeState } from "./core-runtime-state.js";
