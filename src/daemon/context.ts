import type { SashStateStore } from "../app-state.js";
import type { AutostartController } from "../autostart/service.js";
import type { CoreStartResult } from "../contracts.js";
import type { CoreUpdateProgress, CoreUpdateResult } from "../core-update.js";
import type { SashLayout } from "../paths.js";
import type { ProfileService } from "../profile-service.js";
import type { RuntimeLifecycle } from "../runtime-lifecycle.js";
import type { SashSettings } from "../settings.js";
import type { SettingsService } from "../settings-service.js";
import type { CoreSupervisor } from "../supervisor.js";
import type { SystemProxyController } from "../system-proxy-manager.js";
import type { WebAuthManager } from "./auth.js";
import { ShuttingDownError } from "./errors.js";
import type { DaemonEvents } from "./events.js";

/** One queue and one admission gate for all daemon state transitions. Reads remain independent. */
export class DaemonGate {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private cleanupPromise: Promise<void> | undefined;
  private readonly liveMutations = new Set<Promise<void>>();

  constructor(
    private readonly cleanup: () => Promise<void>,
    private readonly cancel: () => void,
    private readonly options: { onChange?: () => void } = {},
  ) {}
  get isClosing(): boolean {
    return this.closing;
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
  }

  /** Runtime-only RPCs stay outside the state queue. */
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

  mutate<T>(action: () => T | Promise<T>): Promise<T> {
    return this.enqueue(action, () => this.assertMutable());
  }

  private enqueue<T>(action: () => T | Promise<T>, admit: () => void): Promise<T> {
    try {
      admit();
    } catch (error) {
      return Promise.reject(error);
    }
    const next = this.tail.then(async () => {
      admit();
      try {
        return await action();
      } finally {
        this.changed();
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
  readonly webAuth: WebAuthManager;
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
  mutate<T>(action: () => T | Promise<T>): Promise<T>;
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
