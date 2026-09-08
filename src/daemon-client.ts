import type { AutostartStatus } from "./autostart-contract.js";
import type {
  CoreStartResult,
  CoreUpdateResponse,
  DaemonStatus,
  HealthInfo,
  SettingsPatch,
  SettingsWriteResult,
  WebBootstrapInfo,
} from "./contracts.js";
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
    headersTimeoutMs: init.timeoutMs,
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

  createWebBootstrap(): Promise<WebBootstrapInfo> {
    return this.client.createWebBootstrap();
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

  autostartStatus(): Promise<AutostartStatus> {
    return this.client.autostartStatus();
  }

  setAutostart(enabled: boolean): Promise<AutostartStatus> {
    return this.client.setAutostart(enabled);
  }

  startCore(): Promise<CoreStartResult> {
    return this.client.startCore();
  }

  restartCore(): Promise<CoreStartResult> {
    return this.client.restartCore();
  }
  updateCore(version?: string): Promise<CoreUpdateResponse> {
    return this.client.updateCore(version);
  }

  patchSettings(patch: SettingsPatch): Promise<SettingsWriteResult> {
    return this.client.patchSettings(patch);
  }

  async shutdown(): Promise<void> {
    // The daemon sends its success response before closing its listener. A
    // response error is therefore a real cleanup failure, not best effort.
    await this.client.shutdown();
  }
}
