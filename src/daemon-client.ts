import { request } from "undici";
import type { AutostartStatus } from "./autostart-contract.js";
import type {
  CoreStartResult,
  CoreUpdateResponse,
  DaemonStatus,
  HealthInfo,
  ProfileActionResponse,
  ProfileActivateResponse,
  ProfileRemoveResponse,
  ProfileRenameResponse,
  ProfilesIndex,
  ProfilesUpdateAllResponse,
  ProfileUpdateResponse,
  SettingsPatch,
  SettingsWriteResult,
  SystemProxyStatusResponse,
  UpgradeRuntimeStatus,
  WebBootstrapInfo,
} from "./contracts.js";
import type { CoreDelayResult } from "./core-delay.js";
import type { CoreUpdateProgress } from "./core-update-progress.js";
import { directDispatcherForLoopback, ERROR_BODY_LIMIT, fetchWithRetry } from "./http.js";
import { SashClient, type SashClientFetch } from "./sash-client.js";
import type { SashEventFetch } from "./sash-event-client.js";
import type { DaemonEvent } from "./sash-events.js";
import type { PublicSashSettings } from "./settings.js";
import type { UpgradeAccess } from "./upgrade-access.js";

// Profile metadata can occupy most of the supported 2 MiB application manifest.
const DAEMON_SUCCESS_BODY_LIMIT = 2 * 1024 * 1024;

/** Loopback-only fetch with retries, deadlines, and body caps for the CLI. */
const daemonFetch: SashClientFetch = async (url, init) => {
  const res = await fetchWithRetry(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    direct: true,
    manualRedirect: true,
    deadlineMs: init.timeoutMs,
    headersTimeoutMs: init.timeoutMs,
    ...(init.attempts !== undefined ? { attempts: init.attempts } : {}),
    signal: init.signal,
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

// Event streams are deliberately long-lived. They use idle/header deadlines,
// cancellation and the direct dispatcher, with no redirects or mutation retries.
const daemonEventFetch: SashEventFetch = async (url, init) => {
  const response = await request(url, {
    method: "GET",
    ...init,
    dispatcher: directDispatcherForLoopback(),
    headersTimeout: 8000,
    bodyTimeout: 25_000,
  });
  response.body.on("error", () => undefined);
  return {
    status: response.statusCode,
    contentType: String(response.headers["content-type"] ?? ""),
    body: response.body,
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
      eventFetchFn: daemonEventFetch,
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

  events(signal: AbortSignal): AsyncGenerator<DaemonEvent> {
    return this.client.events(signal);
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
  stopCore(): Promise<void> {
    return this.client.stopCore();
  }
  setMode(mode: "rule" | "global" | "direct"): Promise<void> {
    return this.client.setMode(mode);
  }
  proxyStatus(): Promise<SystemProxyStatusResponse> {
    return this.client.proxyStatus();
  }
  updateCore(version?: string): Promise<CoreUpdateResponse> {
    return this.client.updateCore(version);
  }
  coreUpdateProgress(): Promise<CoreUpdateProgress | null> {
    return this.client.coreUpdateProgress();
  }
  testDelay(name: string, signal?: AbortSignal): Promise<CoreDelayResult> {
    return this.client.testDelay(name, signal);
  }

  patchSettings(patch: SettingsPatch): Promise<SettingsWriteResult> {
    return this.client.patchSettings(patch);
  }

  getSettings(): Promise<PublicSashSettings> {
    return this.client.getSettings();
  }
  listProfiles(): Promise<ProfilesIndex> {
    return this.client.listProfiles();
  }
  addProfile(
    url: string,
    options: { name?: string; activate?: boolean } = {},
  ): Promise<ProfileActionResponse> {
    return this.client.addProfile(url, options);
  }
  activateProfile(id: string | null): Promise<ProfileActivateResponse> {
    return this.client.activateProfile(id);
  }
  updateProfile(id: string): Promise<ProfileUpdateResponse> {
    return this.client.updateProfile(id);
  }
  updateAllProfiles(): Promise<ProfilesUpdateAllResponse> {
    return this.client.updateAllProfiles();
  }
  renameProfile(id: string, name: string): Promise<ProfileRenameResponse> {
    return this.client.renameProfile(id, name);
  }
  removeProfile(id: string): Promise<ProfileRemoveResponse> {
    return this.client.removeProfile(id);
  }
  upgradeRuntime(
    action: "reserve" | "status" | "verify" | "commit",
    access: UpgradeAccess,
  ): Promise<UpgradeRuntimeStatus> {
    return this.client.upgradeRuntime(action, access);
  }
  upgradeRuntimeAction(
    action: "stop" | "release" | "cleanup",
    access: UpgradeAccess,
  ): Promise<void> {
    return this.client.upgradeRuntimeAction(action, access);
  }

  async shutdown(): Promise<void> {
    // The daemon sends its success response before closing its listener. A
    // response error is therefore a real cleanup failure, not best effort.
    await this.client.shutdown();
  }
}
