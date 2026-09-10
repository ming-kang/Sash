import { type SashStateStore, StateConflictError } from "../app-state.js";
import type { AutostartController } from "../autostart.js";
import type { CoreStartResult } from "../contracts.js";
import type { CoreUpdateResult } from "../core-update.js";
import type { CoreUpdateProgress } from "../core-update-progress.js";
import type { SashLayout } from "../paths.js";
import type { ProfileService } from "../profile-service.js";
import type { RuntimeLifecycle } from "../runtime-lifecycle.js";
import type { SashSettings } from "../settings.js";
import type { SettingsService } from "../settings-service.js";
import type { CoreSupervisor } from "../supervisor.js";
import type { SystemProxyController } from "../system-proxy-manager.js";
import { ShuttingDownError } from "./errors.js";
import type { DaemonEvents } from "./events.js";
import type { DaemonUpgradeService } from "./upgrade.js";
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
  private queued = 0;
  private reservation: string | undefined;
  private readonly liveMutations = new Set<Promise<void>>();

  constructor(
    private readonly cleanup: () => Promise<void>,
    private readonly cancel: () => void,
    private readonly options: {
      slowMutationMs?: number;
      onSlowMutation?: (info: SlowMutationInfo) => void;
      onChange?: () => void;
    } = {},
  ) {}
  get isClosing(): boolean {
    return this.closing;
  }
  get isReserved(): boolean {
    return this.reservation !== undefined;
  }

  private changed(): void {
    try {
      this.options.onChange?.();
    } catch {
      /* Observation must never affect a mutation result. */
    }
  }

  assertMutable(): void {
    if (this.closing) throw new ShuttingDownError();
    if (this.reservation) throw new StateConflictError("A Sash upgrade is in progress");
  }

  /** Close admission synchronously, then drain already executing writes and controller RPCs. */
  async reserve(transactionId: string): Promise<void> {
    if (this.reservation !== transactionId) {
      this.assertMutable();
      this.reservation = transactionId;
      this.cancel();
    }
    await Promise.allSettled([this.tail, ...this.liveMutations]);
  }

  releaseReservation(transactionId: string): void {
    this.assertReserved(transactionId);
    this.reservation = undefined;
  }

  private assertReserved(transactionId: string): void {
    if (this.closing) throw new ShuttingDownError();
    if (this.reservation !== transactionId)
      throw new StateConflictError("Sash upgrade reservation does not match");
  }

  mutateReserved<T>(
    transactionId: string,
    purpose: string,
    action: () => T | Promise<T>,
  ): Promise<T> {
    return this.enqueue(purpose, action, () => this.assertReserved(transactionId));
  }

  /** Runtime-only RPCs stay outside the state queue but participate in the upgrade drain. */
  async runLiveMutation<T>(action: () => T | Promise<T>): Promise<T> {
    this.assertMutable();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.liveMutations.add(pending);
    try {
      return await action();
    } finally {
      this.liveMutations.delete(pending);
      finish();
      this.changed();
    }
  }

  mutate<T>(purpose: string, action: () => T | Promise<T>): Promise<T> {
    return this.enqueue(purpose, action, () => this.assertMutable());
  }

  private enqueue<T>(purpose: string, action: () => T | Promise<T>, admit: () => void): Promise<T> {
    try {
      admit();
    } catch (error) {
      return Promise.reject(error);
    }
    this.queued += 1;
    this.changed();
    const next = this.tail.then(async () => {
      this.queued -= 1;
      this.changed();
      admit();
      const started = performance.now();
      const active = { purpose, startedAt: new Date().toISOString() };
      this.changed();
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
        this.changed();
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
    const attempt = this.enqueue(
      "shut down daemon",
      async () => {
        await Promise.allSettled(this.liveMutations);
        await this.cleanup();
      },
      () => {},
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
  readonly version: string;
  readonly installationId: string;
  readonly webAuth: WebAuthManager;
  readonly upgrade: DaemonUpgradeService;
  readonly profiles: ProfileService;
  readonly settingsService: SettingsService;
  readonly lifecycle: RuntimeLifecycle;
  readonly supervisor: CoreSupervisor;
  readonly coreUpdate: CoreUpdateProgress | null;
  readonly systemProxy: SystemProxyController;
  readonly autostart: AutostartController;
  readonly gate: DaemonGate;
  readonly events: DaemonEvents;
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
