import type { CoreStartResult, ShutdownResult } from "../contracts.js";
import type { GeneratedConfig } from "../mihomo-config.js";
import type { SashLayout } from "../paths.js";
import type { ProfileService } from "../profile-service.js";
import type { RuntimeLifecycle } from "../runtime-lifecycle.js";
import type { SashSettings } from "../settings.js";
import type { SettingsService } from "../settings-service.js";
import type { StateMutationQueue } from "../state-lock.js";
import type { CoreSupervisor } from "../supervisor.js";
import type { SystemProxyController } from "../system-proxy-manager.js";
import { ShuttingDownError } from "./errors.js";

/**
 * Admission gate plus idempotent cleanup for the daemon. Mutations are
 * rejected once shutdown starts; a failed cleanup reopens the gate so the
 * close can be retried.
 */
export class DaemonGate {
  private closing = false;
  private cleanupPromise: Promise<ShutdownResult> | undefined;

  constructor(
    private readonly queue: StateMutationQueue,
    private readonly cleanup: () => Promise<ShutdownResult>,
  ) {}

  get isClosing(): boolean {
    return this.closing;
  }

  async mutate<T>(purpose: string, action: () => T | Promise<T>): Promise<T> {
    if (this.closing) throw new ShuttingDownError();
    return this.queue.run(purpose, () => {
      if (this.closing) throw new ShuttingDownError();
      return action();
    });
  }

  shutdown(): Promise<ShutdownResult> {
    if (this.cleanupPromise) return this.cleanupPromise;
    // Close the admission gate before queueing the snapshot. Mutations already
    // queued finish first; later requests cannot enter after the snapshot.
    this.closing = true;
    const attempt = this.queue.run("close daemon", this.cleanup);
    this.cleanupPromise = attempt;
    void attempt.catch(() => {
      if (this.cleanupPromise === attempt) {
        this.cleanupPromise = undefined;
        this.closing = false;
      }
    });
    return attempt;
  }

  /** Reopen admissions after a failed listener close (cleanup already ran). */
  reopen(): void {
    this.closing = false;
  }
}

/** Services and domain actions shared by the daemon route handlers. */
export interface DaemonContext {
  readonly layout: SashLayout;
  readonly token: string;
  readonly startedAt: string;
  readonly profiles: ProfileService;
  readonly settingsService: SettingsService;
  readonly lifecycle: RuntimeLifecycle;
  readonly supervisor: CoreSupervisor;
  readonly systemProxy: SystemProxyController;
  readonly gate: DaemonGate;
  readonly settings: {
    committed(): SashSettings;
    runtime(): SashSettings;
  };
  mutate<T>(purpose: string, action: () => T | Promise<T>): Promise<T>;
  profileRevision(): number;
  startCore(): Promise<CoreStartResult>;
  restartCore(): Promise<CoreStartResult>;
  reloadCoreConfig(): Promise<GeneratedConfig>;
  shutdown(): Promise<ShutdownResult>;
  /** Wired by server.ts once the HTTP listener exists. */
  closeListener(): Promise<void>;
  readonly onShutdown?: () => void;
}
