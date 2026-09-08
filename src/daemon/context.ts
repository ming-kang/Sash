import type { SashStateStore } from "../app-state.js";
import type { AutostartController } from "../autostart.js";
import type { CoreStartResult, MutationQueueStatus } from "../contracts.js";
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

export interface SlowMutationInfo {
  purpose: string;
  startedAt: string;
  durationMs: number;
  queued: number;
}

/** One queue and one admission gate for all daemon state transitions. Reads remain independent. */
export class DaemonGate {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private cleanupPromise: Promise<void> | undefined;
  private active: MutationQueueStatus["active"] = null;
  private queued = 0;

  constructor(
    private readonly cleanup: () => Promise<void>,
    private readonly cancel: () => void,
    private readonly options: {
      slowMutationMs?: number;
      onSlowMutation?: (info: SlowMutationInfo) => void;
    } = {},
  ) {}
  get isClosing(): boolean {
    return this.closing;
  }

  snapshot(): MutationQueueStatus {
    return { active: this.active ? { ...this.active } : null, queued: this.queued };
  }

  mutate<T>(purpose: string, action: () => T | Promise<T>): Promise<T> {
    return this.enqueue(purpose, action, false);
  }

  private enqueue<T>(
    purpose: string,
    action: () => T | Promise<T>,
    allowClosing: boolean,
  ): Promise<T> {
    if (this.closing && !allowClosing) return Promise.reject(new ShuttingDownError());
    this.queued += 1;
    const next = this.tail.then(async () => {
      this.queued -= 1;
      if (this.closing && !allowClosing) throw new ShuttingDownError();
      const started = performance.now();
      const active = { purpose, startedAt: new Date().toISOString() };
      this.active = active;
      const slowMs = this.options.slowMutationMs ?? 5000;
      let reported = false;
      const reportSlow = (): void => {
        if (reported) return;
        reported = true;
        const info = {
          ...active,
          durationMs: Math.round(performance.now() - started),
          queued: this.queued,
        };
        try {
          if (this.options.onSlowMutation) this.options.onSlowMutation(info);
          else
            console.warn(
              `[sashd] slow mutation: ${purpose} (${info.durationMs}ms, ${info.queued} queued)`,
            );
        } catch {
          /* Diagnostics must not replace a mutation result or break its cleanup. */
        }
      };
      const timer = setTimeout(reportSlow, slowMs);
      timer.unref();
      try {
        return await action();
      } finally {
        clearTimeout(timer);
        this.active = null;
        if (performance.now() - started >= slowMs) reportSlow();
      }
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
    const attempt = this.enqueue("shut down daemon", this.cleanup, true);
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
