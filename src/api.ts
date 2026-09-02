import { ERROR_BODY_LIMIT, fetchWithRetry } from "./http.js";
import { parseControllerAddress } from "./settings.js";

/**
 * Low-level Mihomo external-controller client used internally by the
 * daemon supervisor to check core health and reload config.yaml.
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

  async version(): Promise<string> {
    const res = await this.request("/version", { deadlineMs: 5_000, attempts: 2 });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const summary = (await res.text(ERROR_BODY_LIMIT)).slice(0, 200).trim();
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

  async getTunActive(): Promise<boolean> {
    const res = await this.request("/configs", { deadlineMs: 2_000, attempts: 1 });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const summary = (await res.text(ERROR_BODY_LIMIT)).slice(0, 200).trim();
      throw new Error(`Mihomo API returned HTTP ${res.statusCode}: ${summary}`);
    }
    const text = await res.text(1024 * 1024);
    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Invalid JSON response from Mihomo /configs: ${text.slice(0, 200).trim()}`);
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error("Mihomo /configs response is not an object");
    }
    const tun = (data as Record<string, unknown>).tun;
    if (typeof tun !== "object" || tun === null || Array.isArray(tun)) {
      throw new Error("Mihomo /configs response is missing the TUN runtime state");
    }
    const enable = (tun as Record<string, unknown>).enable;
    if (typeof enable !== "boolean") {
      throw new Error("Mihomo /configs response is missing boolean tun.enable");
    }
    return enable;
  }

  async reloadConfig(configPath: string): Promise<void> {
    const body = JSON.stringify({ path: configPath });
    const res = await this.request("/configs?force=true", {
      method: "PUT",
      body,
      deadlineMs: 5_000,
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      let bodyText = "";
      try {
        bodyText = (await res.text(ERROR_BODY_LIMIT)).trim();
      } catch {
        // The status is still useful if a peer terminates an error body early.
      }
      const summary = bodyText ? `: ${bodyText.slice(0, 300)}` : "";
      throw new Error(`Failed to reload Mihomo config (HTTP ${res.statusCode})${summary}`);
    }
    await res.discard();
  }
}
