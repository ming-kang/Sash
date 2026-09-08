import { MihomoApi } from "./api.js";
import type { CoreStartResult } from "./contracts.js";
import type { StagedCore } from "./core.js";
import {
  type CoreUpdateOptions,
  type CoreUpdateResult,
  commitCoreUpdate,
  readCoreUpdateTransaction,
  recoverCoreUpdateTransaction,
} from "./core-update.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import type { GeneratedConfig } from "./mihomo-config.js";
import type { SashLayout } from "./paths.js";
import { recoverBinaryUnlockProbe } from "./process.js";
import type { SashSettings } from "./settings.js";
import type { CoreSupervisor } from "./supervisor.js";
import type { SystemProxyController } from "./system-proxy-manager.js";

export interface RuntimeConfiguration {
  generated: GeneratedConfig;
  settings: SashSettings;
  profile: { id: string; revision: number; name: string; url: string } | null;
}
export interface RuntimeLifecycleOptions {
  controllerProbe?: (settings: SashSettings) => Promise<boolean>;
  verifyExecutable?: CoreUpdateOptions["verifyExecutable"];
  layout: SashLayout;
  supervisor: CoreSupervisor;
  systemProxy: SystemProxyController;
  settings: () => SashSettings;
}

/** All calls enter the daemon's single mutation queue. This class owns Core and proxy order. */
export class RuntimeLifecycle {
  private runtimeRevision = 0;
  private applied: RuntimeConfiguration | undefined;
  private runtimeSettings: SashSettings;

  constructor(private readonly options: RuntimeLifecycleOptions) {
    this.runtimeSettings = { ...options.settings() };
  }

  get revision(): number {
    return this.runtimeRevision;
  }
  settings(): SashSettings {
    return { ...this.runtimeSettings };
  }
  configuration(): RuntimeConfiguration | undefined {
    return this.applied;
  }

  async recoverStartup(): Promise<void> {
    await this.options.systemProxy.release();
    await this.options.supervisor.cleanStaleCore();
    if (readCoreUpdateTransaction(this.options.layout)) await this.requireVacantController();
    recoverBinaryUnlockProbe(this.options.layout.coreExe);
    recoverCoreUpdateTransaction(this.options.layout, this.options.verifyExecutable);
  }

  private async requireVacantController(): Promise<void> {
    const reachable = this.options.controllerProbe
      ? await this.options.controllerProbe(this.runtimeSettings)
      : await new MihomoApi(
          this.runtimeSettings.controller,
          this.runtimeSettings.secret,
        ).isReachable();
    if (reachable)
      throw new Error(
        "An unowned Core controller is still active; refusing to replace its runtime",
      );
  }

  private startCore(): Promise<CoreStartResult> {
    this.runtimeRevision += 1;
    return this.options.supervisor.start();
  }

  /** Idempotent start for an already running Core; stopped starts go through Apply. */
  async start(): Promise<CoreStartResult> {
    const core = await this.options.supervisor.status();
    if (!core.running || !core.healthy || !core.pid)
      throw new Error("Core is no longer healthy; retry start");
    await this.reconcileSystemProxy();
    return { pid: core.pid, ...(core.version ? { version: core.version } : {}) };
  }

  async apply(configuration: RuntimeConfiguration): Promise<CoreStartResult> {
    await this.stop();
    await this.requireVacantController();
    this.applied = undefined;
    atomicWriteFileSync(this.options.layout.configFile, configuration.generated.yaml);
    this.runtimeSettings = { ...configuration.settings };
    const result = await this.startCore();
    this.applied = configuration;
    await this.reconcileSystemProxy();
    return result;
  }

  async stop(): Promise<void> {
    // A failed proxy release must leave a healthy owned Core available.
    await this.options.systemProxy.release();
    await this.options.supervisor.stop();
    this.runtimeRevision += 1;
  }

  async reconcileSystemProxy(): Promise<void> {
    if (!this.options.settings().systemProxy) {
      await this.options.systemProxy.release();
      return;
    }
    const { supervisor, systemProxy } = this.options;
    const owner = supervisor.ownedCoreSnapshot();
    const core = await supervisor.status();
    if (!owner || !core.running || !core.healthy || !supervisor.ownsCore(owner)) {
      throw new Error("Cannot enable system proxy without a healthy owned Core");
    }
    await systemProxy.apply({ port: this.runtimeSettings.mixedPort });
    const after = await supervisor.status();
    if (after.running && after.healthy && supervisor.ownsCore(owner)) return;
    await systemProxy.release();
    throw new Error("Core ownership was lost while applying the system proxy");
  }

  async update(staged: StagedCore, configuration: RuntimeConfiguration): Promise<CoreUpdateResult> {
    const wasRunning = this.options.supervisor.isRunning();
    if (!wasRunning) {
      atomicWriteFileSync(this.options.layout.configFile, configuration.generated.yaml);
      this.runtimeSettings = { ...configuration.settings };
    }
    return commitCoreUpdate({
      layout: this.options.layout,
      staged,
      verifyExecutable: this.options.verifyExecutable,
      runtime: {
        wasRunning,
        stop: async () => {
          await this.stop();
          await this.requireVacantController();
        },
        startAndVerify: async () => {
          await this.startCore();
          this.applied = configuration;
        },
        applySystemProxy: () => this.reconcileSystemProxy(),
      },
    });
  }

  async handleUnexpectedCoreExit(): Promise<void> {
    if (this.options.supervisor.isRunning()) return;
    this.runtimeRevision += 1;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.options.systemProxy.release();
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
}
