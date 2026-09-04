import type { CoreStartResult, DaemonStatus, HealthInfo, ShutdownResult } from "./contracts.js";
import { ERROR_BODY_LIMIT, fetchWithRetry } from "./http.js";
import { SashClient, type SashClientFetch } from "./sash-client.js";

const DAEMON_SUCCESS_BODY_LIMIT = 1024 * 1024;

/** Loopback-only fetch with retries, deadlines, and body caps for the CLI. */
const daemonFetch: SashClientFetch = async (url, init) => {
  const res = await fetchWithRetry(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    direct: true,
    deadlineMs: init.timeoutMs,
    ...(init.attempts !== undefined ? { attempts: init.attempts } : {}),
  });
  return {
    status: res.statusCode,
    text: () =>
      res.text(
        res.statusCode >= 200 && res.statusCode < 300
          ? DAEMON_SUCCESS_BODY_LIMIT
          : ERROR_BODY_LIMIT,
      ),
  };
};

/** CLI-facing daemon client: SashClient with the Node transport defaults. */
export class SashDaemonClient {
  readonly baseUrl: string;
  private readonly client: SashClient;

  constructor(port: number, secret: string) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    const trimmed = (secret || "").trim();
    this.client = new SashClient({
      baseUrl: this.baseUrl,
      token: () => trimmed,
      fetchFn: daemonFetch,
    });
  }

  health(): Promise<HealthInfo> {
    return this.client.health();
  }

  async isReachable(): Promise<boolean> {
    try {
      return Boolean((await this.health()).token);
    } catch {
      return false;
    }
  }

  status(fresh = false): Promise<DaemonStatus> {
    return this.client.status(fresh);
  }

  startCore(): Promise<CoreStartResult> {
    return this.client.startCore();
  }

  maintenanceShutdown(): Promise<ShutdownResult> {
    return this.client.shutdown();
  }

  async shutdown(): Promise<void> {
    // The daemon sends its success response before closing its listener. A
    // response error is therefore a real cleanup failure, not best effort.
    await this.client.shutdown();
  }
}
