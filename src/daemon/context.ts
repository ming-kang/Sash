import type { SashStateStore } from "../app-state.js";
import type { AutostartController } from "../autostart.js";
import type { CoreStartResult } from "../contracts.js";
import type { CoreUpdateResult } from "../core-update.js";
import type { SashLayout } from "../paths.js";
import type { ProfileService } from "../profile-service.js";
import type { RuntimeLifecycle } from "../runtime-lifecycle.js";
import type { SashSettings } from "../settings.js";
import type { SettingsService } from "../settings-service.js";
import type { CoreSupervisor } from "../supervisor.js";
import type { SystemProxyController } from "../system-proxy-manager.js";
import { ShuttingDownError } from "./errors.js";
import type { WebAuthManager } from "./web-auth.js";

/** One queue and one admission gate for all daemon state transitions. Reads remain independent. */
export class DaemonGate {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private cleanupPromise: Promise<void> | undefined;

  constructor(
    private readonly cleanup: () => Promise<void>,
    private readonly cancel: () => void,
  ) {}
  get isClosing(): boolean {
    return this.closing;
  }

  mutate<T>(_purpose: string, action: () => T | Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new ShuttingDownError());
    const next = this.tail.then(() => {
      if (this.closing) throw new ShuttingDownError();
      return action();
    });
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  shutdown(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.closing = true;
    this.cancel();
    const attempt = this.tail.then(this.cleanup);
    this.tail = attempt.then(
      () => undefined,
      () => undefined,
    );
    this.cleanupPromise = attempt;
    void attempt.catch(() => {
      if (this.cleanupPromise === attempt) {
        this.cleanupPromise = undefined;
        this.closing = false;
      }
    });
    return attempt;
  }

  reopen(): void {
    this.closing = false;
    this.cleanupPromise = undefined;
  }
}

export interface DaemonContext {
  readonly layout: SashLayout;
  readonly state: SashStateStore;
  readonly token: string;
  readonly startedAt: string;
  readonly webAuth: WebAuthManager;
  readonly profiles: ProfileService;
  readonly settingsService: SettingsService;
  readonly lifecycle: RuntimeLifecycle;
  readonly supervisor: CoreSupervisor;
  readonly systemProxy: SystemProxyController;
  readonly autostart: AutostartController;
  readonly gate: DaemonGate;
  readonly settings: { committed(): SashSettings; runtime(): SashSettings };
  mutate<T>(purpose: string, action: () => T | Promise<T>): Promise<T>;
  stateRevision(): number;
  pendingApply(): boolean;
  startCore(): Promise<CoreStartResult>;
  restartCore(): Promise<CoreStartResult>;
  stopCore(): Promise<void>;
  updateCore(version?: string): Promise<CoreUpdateResult>;
  shutdown(): Promise<void>;
  closeListener(): Promise<void>;
  readonly onShutdown?: () => void;
}
