import { fetchWithRetry } from "./http.js";

/**
 * Wildcard binds are listen targets, not connect targets: a browser cannot
 * open http://0.0.0.0. Map them onto the matching loopback address.
 */
function browserHost(hostname: string): string {
  if (hostname === "0.0.0.0") return "127.0.0.1";
  if (hostname === "[::]") return "[::1]";
  return hostname;
}

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

  /** Plain dashboard URL. Carries no credentials; safe to print and log. */
  uiUrl(): string {
    return `${this.browserOrigin().origin}/ui/`;
  }

  /**
   * Dashboard URL that hands the controller address and secret to MetaCubeXD's
   * setup deep-link: its `autoLogin` (packages/ui/composables/useConnect.ts)
   * connects immediately when the hash route carries a `hostname`, reading
   * `port` and `secret` alongside it. The protocol is deliberately omitted so
   * the dashboard reuses whatever the page itself was served over.
   *
   * Values are percent-encoded rather than form-encoded: the dashboard parses
   * this with Vue Router, which decodes via decodeURIComponent and would leave
   * a `+` literal, corrupting any secret containing a space.
   *
   * Embeds the secret — open this URL, do not print it.
   */
  dashboardAuthUrl(): string {
    const url = this.browserOrigin();
    const query = Object.entries({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? "443" : "80"),
      secret: this.secret,
    })
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&");
    return `${url.origin}/ui/#/setup?${query}`;
  }

  /** Origin a browser on this machine can actually reach. */
  private browserOrigin(): URL {
    const url = new URL(this.baseUrl);
    url.hostname = browserHost(url.hostname);
    return url;
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
