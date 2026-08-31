import { fetchWithRetry } from "./http.js";

/**
 * Mihomo (Clash.Meta) external-controller REST client.
 *
 * All requests use direct dispatching so local loopback traffic is never
 * intercepted by HTTP_PROXY or other environment proxy settings.
 */
export class MihomoApi {
  readonly baseUrl: string;
  private readonly secret: string;

  constructor(controller: string, secret: string) {
    const trimmed = (controller || "").trim();
    let base = trimmed;
    if (base && !/^https?:\/\//i.test(base)) {
      base = `http://${base}`;
    } else if (!base) {
      base = "http://127.0.0.1:9090";
    }
    this.baseUrl = base.replace(/\/+$/, "");
    this.secret = (secret || "").trim();
  }

  uiUrl(): string {
    return `${this.baseUrl}/ui`;
  }

  private async request(
    endpoint: string,
    options: {
      method?: string;
      body?: string;
      timeoutMs?: number;
      attempts?: number;
    } = {},
  ) {
    const url = `${this.baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
    const headers: Record<string, string> = {};
    if (this.secret) {
      headers["Authorization"] = `Bearer ${this.secret}`;
    }
    if (options.body) {
      headers["Content-Type"] = "application/json";
    }
    return fetchWithRetry(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body,
      direct: true,
      attempts: options.attempts ?? 2,
      timeoutMs: options.timeoutMs ?? 5_000,
    });
  }

  async isReachable(): Promise<boolean> {
    try {
      const res = await this.request("/version", { timeoutMs: 5_000, attempts: 2 });
      return res.statusCode >= 200 && res.statusCode < 300;
    } catch {
      return false;
    }
  }

  async version(): Promise<string> {
    const res = await this.request("/version", { timeoutMs: 5_000, attempts: 2 });
    const text = await res.text();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const summary = text.slice(0, 200).trim();
      throw new Error(`Mihomo API returned HTTP ${res.statusCode}: ${summary}`);
    }
    try {
      const data = JSON.parse(text) as { version?: unknown; meta?: unknown };
      if (typeof data.version === "string") {
        return data.version;
      }
      return "";
    } catch {
      throw new Error(`Invalid JSON response from Mihomo /version: ${text.slice(0, 200).trim()}`);
    }
  }

  async reloadConfig(configPath: string): Promise<void> {
    const body = JSON.stringify({ path: configPath, force: true });
    const res = await this.request("/configs", {
      method: "PUT",
      body,
      timeoutMs: 5_000,
      attempts: 2,
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      let bodyText = "";
      try {
        bodyText = (await res.text()).trim();
      } catch {
        // ignore
      }
      const summary = bodyText ? `: ${bodyText.slice(0, 300)}` : "";
      throw new Error(`Failed to reload Mihomo config (HTTP ${res.statusCode})${summary}`);
    }
  }
}
