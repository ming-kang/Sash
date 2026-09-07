import type { CoreStartResult } from "./contracts.js";
import type { SashSettings } from "./settings.js";
import type { CoreOwnershipSnapshot, CoreSupervisor } from "./supervisor.js";
import type { SystemProxyController } from "./system-proxy-manager.js";

export type RuntimePhase =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "restarting"
  | "failed";

export interface CoreUpdateStartupController {
  pending(): boolean;
  completeAfterStart(): void;
  rollbackAfterStartFailure(): { coreVersion: string } | null | undefined;
}

export interface RuntimeLifecycleOptions {
  supervisor: CoreSupervisor;
  systemProxy: SystemProxyController;
  settings: () => SashSettings;
  coreUpdate?: CoreUpdateStartupController;
}

export interface RuntimeLifecycleState {
  phase: RuntimePhase;
  generation: number;
}

type StartResult = Omit<CoreStartResult, "ok">;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializes Core and system-proxy transitions behind one desired-runtime
 * boundary. The proxy is restored before a deliberate stop and is only
 * applied after the Core has passed its readiness probe.
 */
export class RuntimeLifecycle {
  private readonly supervisor: CoreSupervisor;
  private readonly systemProxy: SystemProxyController;
  private readonly getSettings: () => SashSettings;
  private readonly coreUpdate?: CoreUpdateStartupController;
  private operationQueue: Promise<void> = Promise.resolve();
  private phase: RuntimePhase;
  private generation = 0;

  constructor(options: RuntimeLifecycleOptions) {
    this.supervisor = options.supervisor;
    this.systemProxy = options.systemProxy;
    this.getSettings = options.settings;
    this.coreUpdate = options.coreUpdate;
    this.phase = this.supervisor.isRunning() ? "running" : "stopped";
  }

  state(): RuntimeLifecycleState {
    return { phase: this.phase, generation: this.generation };
  }

  start(prepare?: () => Promise<void>): Promise<StartResult> {
    return this.enqueue(() => this.startUnlocked(prepare));
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.stopUnlocked());
  }

  restart(prepare?: () => Promise<void>): Promise<StartResult> {
    return this.enqueue(() => this.restartUnlocked(prepare));
  }

  reconcileSystemProxy(): Promise<void> {
    return this.enqueue(() => this.reconcileSystemProxyUnlocked());
  }

  recoverStartup(): Promise<void> {
    return this.enqueue(async () => {
      await this.systemProxy.release();
      this.phase = this.supervisor.isRunning() ? "running" : "stopped";
    });
  }

  handleUnexpectedCoreExit(): Promise<void> {
    return this.enqueue(async () => {
      // The exit callback can be queued while a restart is already replacing
      // that child. Never let a delayed callback tear down the new runtime.
      if (this.supervisor.isRunning()) return;
      this.generation++;
      this.phase = "failed";
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.systemProxy.release();
          this.phase = "stopped";
          return;
        } catch (err) {
          lastError = err;
          if (attempt < 2) await sleep(250 * (attempt + 1));
        }
      }
      throw lastError;
    });
  }

  close(): Promise<void> {
    return this.enqueue(() => this.stopUnlocked());
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async startUnlocked(prepare?: () => Promise<void>): Promise<StartResult> {
    if (this.supervisor.isRunning()) {
      const status = await this.supervisor.status();
      if (!status.pid) throw new Error("Core reports running without a process identifier");
      if (!status.healthy) {
        throw new Error(`Core process is running but unhealthy (PID=${status.pid})`);
      }
      this.coreUpdate?.completeAfterStart();
      await this.reconcileSystemProxyUnlocked();
      return {
        pid: status.pid,
        ...(status.version ? { version: status.version } : {}),
        ...(status.tunActive !== undefined ? { tunActive: status.tunActive } : {}),
      };
    }

    this.generation++;
    this.phase = "starting";
    let startAttempted = false;
    try {
      // A prior daemon may have crashed after taking over the OS proxy.
      await this.systemProxy.release();
      await prepare?.();
      startAttempted = true;
      const result = await this.supervisor.start();
      this.coreUpdate?.completeAfterStart();
      this.phase = "running";
      await this.applyDesiredProxyUnlocked();
      return result;
    } catch (err) {
      if (startAttempted && !this.supervisor.isRunning() && this.coreUpdate) {
        let pending: boolean;
        try {
          pending = this.coreUpdate.pending();
        } catch (inspectError) {
          this.phase = "failed";
          throw new Error(
            `${(err as Error).message}; pending Core update inspection failed: ${(inspectError as Error).message}`,
          );
        }
        if (pending) {
          let previous: { coreVersion: string } | null | undefined;
          try {
            previous = this.coreUpdate.rollbackAfterStartFailure();
            if (previous) {
              await this.supervisor.start();
              this.phase = "running";
              await this.applyDesiredProxyUnlocked();
            } else {
              this.phase = "stopped";
            }
          } catch (rollbackError) {
            this.phase = this.supervisor.isRunning() ? "running" : "failed";
            throw new Error(
              `${(err as Error).message}; Core update rollback failed: ${(rollbackError as Error).message}`,
            );
          }
          const destination = previous ? ` to ${previous.coreVersion}` : "";
          throw new Error(`${(err as Error).message}; Core update rolled back${destination}`);
        }
      }
      this.phase = this.supervisor.isRunning() ? "running" : "failed";
      throw err;
    }
  }

  private async stopUnlocked(): Promise<void> {
    this.generation++;
    this.phase = "stopping";
    try {
      // Fail closed: never deliberately leave the OS proxy pointing at a Core
      // that Sash is about to stop.
      await this.systemProxy.release();
      await this.supervisor.stop();
      this.phase = "stopped";
    } catch (err) {
      this.phase = this.supervisor.isRunning() ? "running" : "failed";
      throw err;
    }
  }

  private async restartUnlocked(prepare?: () => Promise<void>): Promise<StartResult> {
    this.generation++;
    this.phase = "restarting";
    try {
      // Prepare and validate the candidate while the known-good runtime still
      // exists, then restore the OS proxy before replacing that runtime.
      await prepare?.();
      await this.systemProxy.release();
      const result = await this.supervisor.restart();
      this.phase = "running";
      await this.applyDesiredProxyUnlocked();
      return result;
    } catch (err) {
      this.phase = this.supervisor.isRunning() ? "running" : "failed";
      throw err;
    }
  }

  private async reconcileSystemProxyUnlocked(): Promise<void> {
    const settings = this.getSettings();
    if (!settings.systemProxy) {
      await this.systemProxy.release();
      return;
    }
    await this.applyProxyToHealthyOwnedCoreUnlocked(settings.mixedPort);
  }

  private async applyDesiredProxyUnlocked(): Promise<void> {
    const settings = this.getSettings();
    if (!settings.systemProxy) return;
    await this.applyProxyToHealthyOwnedCoreUnlocked(settings.mixedPort);
  }

  private async applyProxyToHealthyOwnedCoreUnlocked(port: number): Promise<void> {
    const ownership = await this.requireHealthyOwnedCoreUnlocked();
    await this.systemProxy.apply({ port });
    const coreAfterApply = await this.supervisor.status();
    if (coreAfterApply.running && coreAfterApply.healthy && this.supervisor.ownsCore(ownership)) {
      return;
    }

    // Do not leave the OS pointing at a Core which exited or was replaced
    // while its proxy settings were being applied.
    try {
      await this.systemProxy.release();
    } catch (err) {
      throw new Error(
        `Core ownership was lost while applying the system proxy; proxy release also failed: ${(err as Error).message}`,
      );
    }
    throw new Error("Core ownership was lost while applying the system proxy");
  }

  private async requireHealthyOwnedCoreUnlocked(): Promise<CoreOwnershipSnapshot> {
    const ownership = this.supervisor.ownedCoreSnapshot();
    if (!ownership) throw new Error("Cannot enable system proxy: core is not running");

    const core = await this.supervisor.status();
    if (!core.running || !core.healthy) {
      throw new Error("Cannot enable system proxy: core is not healthy");
    }
    if (!this.supervisor.ownsCore(ownership)) {
      throw new Error("Cannot enable system proxy: core ownership changed during health check");
    }
    return ownership;
  }
}
