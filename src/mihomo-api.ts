import type { RoutingMode } from "./contracts.js";
import {
  CORE_DELAY_REQUEST_MS,
  CORE_DELAY_TIMEOUT_MS,
  CORE_DELAY_URL,
  type CoreDelayOutcome,
  type CoreDelayResult,
  delayFailureState,
  validateDelayTarget,
} from "./core-delay.js";
import { errorDetail } from "./error-utils.js";
import { fetchWithRetry, readErrorSummary } from "./http.js";
import { isPlainObject } from "./json-shape.js";
import { parseControllerAddress } from "./settings.js";

/* ── Core API DTOs (upstream external controller contract) ── */

export interface ProxyItem {
  name: string;
  type: string;
  udp: boolean;
  history: Array<{ time: string; delay: number }>;
  now?: string;
  all?: string[];
  alive?: boolean;
}

export interface ProxiesResponse {
  proxies: Record<string, ProxyItem>;
}

export interface ConnectionItem {
  id: string;
  metadata: {
    network: string;
    type: string;
    sourceIP: string;
    destinationIP: string;
    sourcePort: string;
    destinationPort: string;
    host: string;
    dnsMode?: string;
    processPath?: string;
  };
  upload: number;
  download: number;
  start: string;
  chains: string[];
  rule: string;
  rulePayload: string;
}

export interface ConnectionsResponse {
  downloadTotal: number;
  uploadTotal: number;
  connections: ConnectionItem[] | null;
}

export interface TrafficMessage {
  up: number;
  down: number;
}

export interface LogMessage {
  type: "info" | "warning" | "error" | "debug";
  payload: string;
  time?: string;
}

export interface RuleItem {
  type: string;
  payload: string;
  proxy: string;
}

export interface RulesResponse {
  rules: RuleItem[];
}

export interface ConfigsResponse {
  port: number;
  "socks-port": number;
  "redir-port": number;
  "tproxy-port": number;
  "mixed-port": number;
  "allow-lan": boolean;
  mode: RoutingMode;
  "log-level": string;
}

/**
 * Budget for a configuration reload. The Core applies a configuration under a
 * global lock, blocking on every provider's first load and on any geodata
 * database it still has to fetch, so a reload answers far later than the short
 * default API budget. It matches the budget the Core itself gets for a
 * configuration test that may fetch geodata through a mirror set
 * (CONFIG_TEST_GEODATA_TIMEOUT_MS), because the reload can do the same work.
 */
export const CORE_RELOAD_TIMEOUT_MS = 180_000;

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
      signal?: AbortSignal;
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
      signal: options.signal,
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
      throw new Error(`Core controller returned HTTP ${res.statusCode}: ${summary}`);
    }
    const text = await res.text(1024 * 1024);
    let data: { version?: unknown; meta?: unknown };
    try {
      data = JSON.parse(text) as { version?: unknown; meta?: unknown };
    } catch {
      throw new Error(
        `Invalid JSON response from Core controller /version: ${text.slice(0, 200).trim()}`,
      );
    }
    if (typeof data.version === "string" && data.version.trim()) return data.version.trim();
    throw new Error("Core controller /version response is missing a non-empty version");
  }
  async setMode(mode: RoutingMode): Promise<void> {
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

  /**
   * Reload the configuration the Core is running from an absolute path. The
   * Core swaps proxies, rules and DNS in place, so connections established
   * before the reload keep their current outbound; only new connections see
   * the new configuration. Listener-level settings (ports, LAN binding) are
   * not part of a reload and still need a restart.
   *
   * The Core answers only after it has finished applying: `PUT /configs` holds
   * its configuration lock while every provider loads for the first time and
   * any geodata database it still needs is fetched, so a reload routinely
   * outlives an ordinary controller call. It therefore carries its own budget
   * (see CORE_RELOAD_TIMEOUT_MS) instead of the short default one.
   */
  async reloadConfig(path: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request("/configs", {
      method: "PUT",
      body: JSON.stringify({ path }),
      attempts: 1,
      deadlineMs: CORE_RELOAD_TIMEOUT_MS,
      signal,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const message = await readErrorSummary(response);
      throw new Error(
        `Core rejected the configuration reload: HTTP ${response.statusCode}: ${message}`,
      );
    }
    await response.discard();
  }

  /** One explicit outbound probe; a group uses its current outbound, never all members. */
  async delay(name: string, signal?: AbortSignal): Promise<CoreDelayResult> {
    validateDelayTarget(name);
    signal?.throwIfAborted();
    const budget = AbortSignal.timeout(CORE_DELAY_REQUEST_MS);
    const requestSignal = signal ? AbortSignal.any([signal, budget]) : budget;
    let outcome: CoreDelayOutcome;
    try {
      const query = new URLSearchParams({
        url: CORE_DELAY_URL,
        timeout: String(CORE_DELAY_TIMEOUT_MS),
        expected: "204",
      });
      const response = await this.request(`/proxies/${encodeURIComponent(name)}/delay?${query}`, {
        attempts: 1,
        deadlineMs: CORE_DELAY_REQUEST_MS + 1000,
        signal: requestSignal,
      });
      if (response.statusCode === 200) {
        const text = await response.text(4096);
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error("Core returned invalid JSON for the delay test");
        }
        if (
          !isPlainObject(data) ||
          typeof data.delay !== "number" ||
          !Number.isSafeInteger(data.delay) ||
          data.delay <= 0
        )
          throw new Error("Core returned an invalid delay measurement");
        outcome = { state: "ok", delayMs: data.delay, error: null };
      } else {
        const summary = await readErrorSummary(response);
        outcome = {
          state: delayFailureState(response.statusCode),
          delayMs: null,
          error:
            response.statusCode === 404
              ? "No node or group has that exact name in the running configuration"
              : `Core delay test returned HTTP ${response.statusCode}${summary ? `: ${summary}` : ""}`,
        };
      }
    } catch (error) {
      signal?.throwIfAborted();
      outcome = {
        state: budget.aborted ? "timeout" : "failed",
        delayMs: null,
        error: budget.aborted
          ? "Core did not finish the delay test within its request deadline"
          : error instanceof Error
            ? error.message
            : String(error),
      };
    }
    signal?.throwIfAborted();
    if (outcome.error !== null) outcome.error = errorDetail(outcome.error);
    return {
      ...outcome,
      name,
      url: CORE_DELAY_URL,
      timeoutMs: CORE_DELAY_TIMEOUT_MS,
      testedAt: new Date().toISOString(),
    };
  }
}
