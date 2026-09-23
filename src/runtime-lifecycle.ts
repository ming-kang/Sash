import type { CoreStartResult } from "./contracts.js";
import type { StagedCore } from "./core.js";
import {
  type CoreUpdateResult,
  commitCoreUpdate,
  readCoreUpdateTransaction,
  recoverBinaryUnlockProbe,
  recoverCoreUpdateTransaction,
} from "./core-update.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { MihomoApi } from "./mihomo-api.js";
import type { GeneratedConfig } from "./mihomo-config.js";
import type { SashLayout } from "./paths.js";
import type { SashSettings } from "./settings.js";
import type { CoreSupervisor } from "./supervisor.js";
import type { SystemProxyController } from "./sysproxy/manager.js";

export interface RuntimeConfiguration {
  generated: GeneratedConfig;
  settings: SashSettings;
  profile: { id: string; revision: number; name: string; url: string } | null;
}
/** What the saved state asks the runtime to become. */
export interface RuntimeTarget {
  profile: { id: string; revision: number } | null;
  settings: SashSettings;
}
export interface RuntimeDelta {
  /** The running Core does not match the saved state. */
  pending: boolean;
  /** Closing the difference needs a Core restart: listener-level settings. */
  restartRequired: boolean;
}
export interface RuntimeLifecycleOptions {
  controllerProbe?: (settings: SashSettings) => Promise<boolean>;
  layout: SashLayout;
  supervisor: CoreSupervisor;
  systemProxy: SystemProxyController;
  settings: () => SashSettings;
}

/**
 * True when listener-level settings differ: the Core re-binds its inbound
 * listeners on a restart only, never on a configuration reload.
 */
export function listenerSettingsChanged(
  applied: Pick<SashSettings, "mixedPort" | "allowLan">,
  target: Pick<SashSettings, "mixedPort" | "allowLan">,
): boolean {
  return applied.mixedPort !== target.mixedPort || applied.allowLan !== target.allowLan;
}

/**
 * Compare what the Core runs with what the saved state asks for. Ports and LAN
 * binding belong to listeners the Core cannot re-bind during a reload, so they
 * are the only difference a restart can close.
 */
export function runtimeDelta(
  applied: RuntimeConfiguration | undefined,
  target: RuntimeTarget,
): RuntimeDelta {
  if (!applied) return { pending: true, restartRequired: false };
  const restartRequired = listenerSettingsChanged(applied.settings, target.settings);
  const appliedProfile = applied.profile;
  const targetProfile = target.profile;
  const profilePending =
    appliedProfile?.id !== targetProfile?.id ||
    appliedProfile?.revision !== targetProfile?.revision;
  return { pending: profilePending || restartRequired, restartRequired };
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
    recoverCoreUpdateTransaction(this.options.layout);
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

  private async startCore(): Promise<CoreStartResult> {
    this.runtimeRevision += 1;
    return {
      ...(await this.options.supervisor.start()),
      alreadyRunning: false,
      mixedPort: this.runtimeSettings.mixedPort,
    };
  }

  /** Idempotent start for an already running Core; stopped starts go through Apply. */
  async start(): Promise<CoreStartResult> {
    const core = await this.options.supervisor.status();
    if (!core.running || !core.healthy || !core.pid)
      throw new Error("Core is no longer healthy; retry start");
    await this.reconcileSystemProxy();
    return {
      pid: core.pid,
      ...(core.version ? { version: core.version } : {}),
      alreadyRunning: true,
      mixedPort: this.runtimeSettings.mixedPort,
    };
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

  /**
   * Apply a configuration to the running Core without restarting it: the Core
   * swaps proxies, rules and DNS in place, so connections established before
   * the reload keep their current outbound. Listener-level settings (ports,
   * LAN binding, the controller) are not part of a reload, so callers fall
   * back to `apply` when those differ.
   */
  async reload(configuration: RuntimeConfiguration): Promise<CoreStartResult> {
    const applied = this.applied;
    if (!applied) throw new Error("Core configuration is unknown; apply it with a restart");
    atomicWriteFileSync(this.options.layout.configFile, configuration.generated.yaml);
    const api = new MihomoApi(this.runtimeSettings.controller, this.runtimeSettings.secret);
    try {
      await api.reloadConfig(this.options.layout.configFile);
    } catch (error) {
      // The Core still runs the previous configuration; keep the file telling
      // the same story so a later restart cannot pick up a rejected one.
      atomicWriteFileSync(this.options.layout.configFile, applied.generated.yaml);
      throw error;
    }
    this.applied = configuration;
    this.runtimeSettings = { ...configuration.settings };
    this.runtimeRevision += 1;
    const core = await this.options.supervisor.status();
    if (!core.running || !core.healthy || !core.pid)
      throw new Error("Core did not stay healthy after the configuration reload");
    await this.reconcileSystemProxy();
    return {
      pid: core.pid,
      ...(core.version ? { version: core.version } : {}),
      alreadyRunning: true,
      mixedPort: this.runtimeSettings.mixedPort,
    };
  }

  async stop(): Promise<void> {
    // A failed proxy release must leave a healthy owned Core available.
    await this.options.systemProxy.release();
    await this.options.supervisor.stop();
    this.runtimeRevision += 1;
  }

  async reconcileSystemProxy(enabled = this.options.settings().systemProxy): Promise<void> {
    if (!enabled) {
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
  }

  async update(
    staged: StagedCore,
    configuration: RuntimeConfiguration,
    startAfterInstall = false,
  ): Promise<CoreUpdateResult> {
    const wasRunning = this.options.supervisor.isRunning();
    if (!wasRunning) {
      atomicWriteFileSync(this.options.layout.configFile, configuration.generated.yaml);
      this.runtimeSettings = { ...configuration.settings };
    }
    return commitCoreUpdate({
      layout: this.options.layout,
      staged,
      runtime: {
        wasRunning: wasRunning || startAfterInstall,
        stop: async () => {
          await this.stop();
          await this.requireVacantController();
        },
        // The installed path already holds the right binary, and the generated
        // configuration is version-independent, so the runtime starts the same
        // way for the install and for the rollback.
        startAndVerify: async (_version) => {
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
