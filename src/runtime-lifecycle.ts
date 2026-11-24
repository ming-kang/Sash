import fs from "node:fs/promises";
import YAML from "yaml";
import type { CoreStartResult } from "./contracts.js";
import type { StagedCore } from "./core.js";
import {
  type CoreUpdateResult,
  commitCoreUpdate,
  readCoreUpdateTransaction,
  recoverBinaryUnlockProbe,
  recoverCoreUpdateTransaction,
} from "./core-update.js";
import { type CoreEngine, mihomoEngine } from "./engine/index.js";
import { errorMessage } from "./error-utils.js";
import { atomicWriteFile } from "./fs-atomic.js";
import { isRequestDeadlineError } from "./http.js";
import type { GeneratedConfig } from "./mihomo-config.js";
import type { SashLayout } from "./paths.js";
import type { SashSettings } from "./settings.js";
import type { CoreSupervisor } from "./supervisor.js";
import type { SystemProxyController } from "./sysproxy/manager.js";
import type { TunService } from "./tun-service.js";
import { sameTunSettings } from "./tun-settings.js";

export interface RuntimeConfiguration {
  generated: GeneratedConfig;
  settings: SashSettings;
  profile: { id: string; revision: number; name: string; url: string } | null;
}
export interface RuntimeTarget {
  profile: { id: string; revision: number } | null;
  settings: SashSettings;
}
export interface RuntimeDelta {
  pending: boolean;
  restartRequired: boolean;
}
export interface RuntimeLifecycleOptions {
  controllerProbe?: (settings: SashSettings) => Promise<boolean>;
  reloadConfig?: (path: string, signal?: AbortSignal) => Promise<void>;
  layout: SashLayout;
  supervisor: CoreSupervisor;
  systemProxy: SystemProxyController;
  settings: () => SashSettings;
  engine?: CoreEngine;
  tun?: TunService;
}

export function listenerSettingsChanged(
  applied: Pick<SashSettings, "mixedPort" | "allowLan" | "tun">,
  target: Pick<SashSettings, "mixedPort" | "allowLan" | "tun">,
): boolean {
  return (
    applied.mixedPort !== target.mixedPort ||
    applied.allowLan !== target.allowLan ||
    !sameTunSettings(applied.tun, target.tun)
  );
}

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

export class RuntimeLifecycle {
  private readonly engine: CoreEngine;
  private runtimeRevision = 0;
  private applied: RuntimeConfiguration | undefined;
  private runtimeSettings: SashSettings;

  constructor(private readonly options: RuntimeLifecycleOptions) {
    this.engine = options.engine ?? mihomoEngine;
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
      : await this.engine
          .api(this.runtimeSettings.controller, this.runtimeSettings.secret)
          .isReachable();
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
    const saved = this.applied;
    const previous = this.options.supervisor.isRunning() ? saved : undefined;
    const changesTun =
      (previous?.settings.tun.enable ?? false) !== configuration.settings.tun.enable ||
      (previous?.settings.tun.enable === true &&
        !sameTunSettings(previous.settings.tun, configuration.settings.tun));
    if (configuration.settings.tun.enable) {
      if (!this.options.tun) throw new Error("TUN Mode is not available");
      await this.options.tun.checkReady();
    }
    await this.stop();
    try {
      return await this.startConfiguration(configuration);
    } catch (error) {
      if (!changesTun && !configuration.settings.tun.enable) throw error;
      try {
        await this.stop();
        this.applied = undefined;
        if (previous) await this.startConfiguration(previous);
        else {
          this.runtimeSettings = {
            ...configuration.settings,
            tun: { ...configuration.settings.tun, enable: false },
          };
          if (saved) await atomicWriteFile(this.options.layout.configFile, saved.generated.yaml);
          else await fs.rm(this.options.layout.configFile, { force: true });
        }
      } catch (rollbackError) {
        throw new Error(
          `${errorMessage(error)}; TUN rollback failed: ${errorMessage(rollbackError)}`,
        );
      }
      throw error;
    }
  }

  private async startConfiguration(configuration: RuntimeConfiguration): Promise<CoreStartResult> {
    await this.requireVacantController();
    this.applied = undefined;
    await atomicWriteFile(this.options.layout.configFile, configuration.generated.yaml);
    this.runtimeSettings = { ...configuration.settings };
    const result = await this.startCore();
    this.applied = configuration;
    await this.reconcileSystemProxy();
    return result;
  }

  /**
   * Apply a configuration to the running Core without restarting it: the Core
   * swaps proxies, rules and DNS in place, so connections established before
   * the reload keep their current outbound. Sash does not request forced
   * listener rebinding, so ports and LAN settings take the `apply` path;
   * the Core controller is never changed by a reload.
   */
  async reload(
    configuration: RuntimeConfiguration,
    signal?: AbortSignal,
  ): Promise<CoreStartResult> {
    signal?.throwIfAborted();
    const applied = this.applied;
    if (!applied) throw new Error("Core configuration is unknown; apply it with a restart");
    if (!sameTunSettings(applied.settings.tun, configuration.settings.tun))
      throw new Error("TUN settings changes require a supervised restart");
    await atomicWriteFile(this.options.layout.configFile, configuration.generated.yaml);
    const { controller, secret } = this.runtimeSettings;
    const reloadConfig =
      this.options.reloadConfig ??
      ((path, signal) => this.engine.api(controller, secret).reloadConfig(path, signal));
    try {
      await reloadConfig(this.options.layout.configFile, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (isRequestDeadlineError(error)) {
        throw new Error(
          `The Core did not answer the configuration reload within ${error.deadlineMs}ms — it may already be running the new configuration; Sash keeps it and reconciles on the next change`,
          { cause: error },
        );
      }
      try {
        await atomicWriteFile(this.options.layout.configFile, applied.generated.yaml);
      } catch (writeError) {
        throw new Error(
          `Core refused the configuration reload, and the previous configuration could not be restored to disk: ${errorMessage(writeError)}`,
          { cause: writeError },
        );
      }
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
    const tun = configuration.settings.tun;
    const smoke = tun.enable
      ? {
          ...configuration,
          settings: { ...configuration.settings, tun: { ...tun, enable: false } },
          generated: {
            ...configuration.generated,
            yaml: YAML.stringify({
              ...YAML.parse(configuration.generated.yaml),
              tun: { enable: false },
            }),
          },
        }
      : configuration;
    if (!wasRunning || tun.enable) {
      if (wasRunning) await this.stop();
      await atomicWriteFile(this.options.layout.configFile, smoke.generated.yaml);
      this.runtimeSettings = { ...smoke.settings };
    }
    let result: CoreUpdateResult;
    try {
      result = await commitCoreUpdate({
        layout: this.options.layout,
        staged,
        runtime: {
          wasRunning: !tun.enable && (wasRunning || startAfterInstall),
          stop: async () => {
            await this.stop();
            await this.requireVacantController();
          },
          startAndVerify: async () => {
            await this.startCore();
            this.applied = smoke;
          },
          applySystemProxy: () => this.reconcileSystemProxy(),
        },
      });
    } catch (error) {
      if (tun.enable && wasRunning) {
        try {
          await this.apply(configuration);
        } catch (rollbackError) {
          throw new Error(
            `${errorMessage(error)}; TUN restart failed: ${errorMessage(rollbackError)}`,
          );
        }
      }
      throw error;
    }
    if (tun.enable) {
      this.applied = undefined;
      if (wasRunning || startAfterInstall) {
        try {
          await this.apply(configuration);
        } catch (error) {
          throw new Error(
            `Core updated to ${staged.version}, but TUN could not restart: ${errorMessage(error)}`,
          );
        }
      }
    }
    return result;
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
