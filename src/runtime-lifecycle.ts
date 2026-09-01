import type { CoreStartResult } from "./contracts.js";
import type { SashSettings } from "./settings.js";
import type { CoreSupervisor } from "./supervisor.js";
import type { SystemProxyController } from "./system-proxy-manager.js";

export type RuntimePhase =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "restarting"
  | "failed";

export interface RuntimeLifecycleOptions {
  supervisor: CoreSupervisor;
  systemProxy: SystemProxyController;
  settings: () => SashSettings;
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
  private operationQueue: Promise<void> = Promise.resolve();
  private phase: RuntimePhase;
  private generation = 0;

  constructor(options: RuntimeLifecycleOptions) {
    this.supervisor = options.supervisor;
    this.systemProxy = options.systemProxy;
    this.getSettings = options.settings;
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
      await this.systemProxy.recover();
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
      await this.reconcileSystemProxyUnlocked();
      return { pid: status.pid, ...(status.version ? { version: status.version } : {}) };
    }

    this.generation++;
    this.phase = "starting";
    try {
      // A prior daemon may have crashed after taking over the OS proxy.
      await this.systemProxy.recover();
      await prepare?.();
      const result = await this.supervisor.start();
      this.phase = "running";
      await this.applyDesiredProxyUnlocked();
      return result;
    } catch (err) {
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
    if (this.getSettings().systemProxy) {
      if (!this.supervisor.isRunning()) {
        throw new Error("Cannot enable system proxy: core is not running");
      }
      const core = await this.supervisor.status();
      if (!core.running || !core.healthy) {
        throw new Error("Cannot enable system proxy: core is not healthy");
      }
      await this.systemProxy.apply({ port: this.getSettings().mixedPort });
      return;
    }
    await this.systemProxy.release();
  }

  private async applyDesiredProxyUnlocked(): Promise<void> {
    if (!this.getSettings().systemProxy) return;
    await this.systemProxy.apply({ port: this.getSettings().mixedPort });
  }
}
