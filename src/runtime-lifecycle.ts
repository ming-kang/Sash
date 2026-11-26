import type { ConfigurationPendingChanges, CoreStartResult } from "./contracts.js";
import type { StagedCore } from "./core.js";
import {
  type CoreUpdateResult,
  commitCoreUpdate,
  readCoreUpdateTransaction,
  recoverBinaryUnlockProbe,
  recoverCoreUpdateTransaction,
} from "./core-update.js";
import type { CoreEngine } from "./engine/index.js";
import { errorMessage, errorPresentation, withErrorPresentation } from "./error-utils.js";
import { atomicWriteFile } from "./fs-atomic.js";
import { isRequestDeadlineError } from "./http.js";
import { type GeneratedConfig, tunDisabledGeneratedConfig } from "./mihomo-config.js";
import type { SashLayout } from "./paths.js";
import type { SashSettings } from "./settings.js";
import type { CoreSupervisor } from "./supervisor.js";
import type { SystemProxyController } from "./sysproxy/manager.js";
import type { TunGuardLike } from "./tun-guard.js";
import type { TunService } from "./tun-service.js";
import { disabledTun, sameEffectiveTunSettings } from "./tun-settings.js";

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
  pendingChanges: ConfigurationPendingChanges;
}
export interface RuntimeLifecycleOptions {
  controllerProbe?: (settings: SashSettings) => Promise<boolean>;
  reloadConfig?: (path: string, signal?: AbortSignal) => Promise<void>;
  layout: SashLayout;
  supervisor: CoreSupervisor;
  systemProxy: SystemProxyController;
  settings: () => SashSettings;
  engine: CoreEngine;
  tun: TunService;
  tunGuard?: TunGuardLike;
}

export class CoreStartError extends Error {
  readonly restored: RuntimeConfiguration | undefined;

  constructor(
    message: string,
    options: { cause: unknown; restored: RuntimeConfiguration | undefined },
  ) {
    super(message, { cause: options.cause });
    this.name = "CoreStartError";
    this.restored = options.restored;
    const presentation = errorPresentation(options.cause);
    if (presentation) withErrorPresentation(this, presentation);
  }
}

export class CoreUpdateResumeError extends CoreStartError {
  constructor(message: string, cause: unknown) {
    super(message, { cause, restored: undefined });
    this.name = "CoreUpdateResumeError";
  }
}

export function verificationConfiguration(
  configuration: RuntimeConfiguration,
): RuntimeConfiguration {
  if (!configuration.settings.tun.enable) return configuration;
  // Verification must not need TUN privilege: replacing the Core file drops POSIX file-based grants.
  return {
    ...configuration,
    settings: {
      ...configuration.settings,
      tun: disabledTun(configuration.settings.tun),
    },
    generated: tunDisabledGeneratedConfig(configuration.generated),
  };
}

function restartRequiringSettingChanges(
  applied: Pick<SashSettings, "mixedPort" | "allowLan" | "tun">,
  target: Pick<SashSettings, "mixedPort" | "allowLan" | "tun">,
): Pick<ConfigurationPendingChanges, "mixedPort" | "allowLan" | "tun"> {
  return {
    mixedPort: applied.mixedPort !== target.mixedPort,
    allowLan: applied.allowLan !== target.allowLan,
    tun: !sameEffectiveTunSettings(applied.tun, target.tun),
  };
}

export function restartRequiringSettingsChanged(
  applied: Pick<SashSettings, "mixedPort" | "allowLan" | "tun">,
  target: Pick<SashSettings, "mixedPort" | "allowLan" | "tun">,
): boolean {
  const changes = restartRequiringSettingChanges(applied, target);
  return changes.mixedPort || changes.allowLan || changes.tun;
}

export function runtimeDelta(
  applied: RuntimeConfiguration | undefined,
  target: RuntimeTarget,
): RuntimeDelta {
  if (!applied)
    return {
      pending: true,
      restartRequired: false,
      pendingChanges: {
        profile: false,
        mixedPort: false,
        allowLan: false,
        tun: false,
        runtimeUnknown: true,
      },
    };
  const appliedProfile = applied.profile;
  const targetProfile = target.profile;
  const restartChanges = restartRequiringSettingChanges(applied.settings, target.settings);
  const pendingChanges: ConfigurationPendingChanges = {
    profile:
      appliedProfile?.id !== targetProfile?.id ||
      appliedProfile?.revision !== targetProfile?.revision,
    ...restartChanges,
    runtimeUnknown: false,
  };
  const restartRequired = restartChanges.mixedPort || restartChanges.allowLan || restartChanges.tun;
  return {
    pending:
      pendingChanges.profile ||
      pendingChanges.mixedPort ||
      pendingChanges.allowLan ||
      pendingChanges.tun,
    restartRequired,
    pendingChanges,
  };
}

const CORE_RESTORE_DELAYS_MS = [500, 1_500, 3_000, 6_000, 10_000, 15_000, 25_000];
const CORE_RECOVERY_WINDOW_MS = 10 * 60 * 1000;
const CORE_RECOVERY_CYCLES_PER_WINDOW = 3;

export class RuntimeLifecycle {
  private readonly engine: CoreEngine;
  private runtimeRevision = 0;
  private applied: RuntimeConfiguration | undefined;
  private runtimeSettings: SashSettings;
  private recoveryCycles: number[] = [];

  constructor(private readonly options: RuntimeLifecycleOptions) {
    this.engine = options.engine;
    this.runtimeSettings = { ...options.settings() };
  }

  get revision(): number {
    return this.runtimeRevision;
  }
  get tunGuard(): TunGuardLike | undefined {
    return this.options.tunGuard;
  }
  get systemProxySupported(): boolean {
    return this.options.systemProxy.supported;
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
    const previous = this.options.supervisor.isRunning() ? this.applied : undefined;
    if (configuration.settings.tun.enable) {
      try {
        await this.options.tun.checkReady();
      } catch (error) {
        throw new CoreStartError(errorMessage(error), { cause: error, restored: previous });
      }
    }
    try {
      await this.stop();
      return await this.startConfiguration(configuration);
    } catch (error) {
      if (!previous)
        throw new CoreStartError(errorMessage(error), { cause: error, restored: undefined });
      try {
        await this.stop();
        this.applied = undefined;
        await this.startConfiguration(previous);
      } catch (restoreError) {
        throw new CoreStartError(
          `${errorMessage(error)}; restoring the previous configuration failed: ${errorMessage(restoreError)}`,
          { cause: error, restored: undefined },
        );
      }
      throw new CoreStartError(errorMessage(error), { cause: error, restored: previous });
    }
  }

  private reconcileTunGuard(configuration: RuntimeConfiguration): void {
    const guard = this.options.tunGuard;
    if (!guard) return;
    const tun = configuration.settings.tun;
    const reconciled = tun.enable
      ? guard.reconcile("setup", { device: tun.device })
      : guard.reconcile("teardown", {});
    void reconciled.catch((error: unknown) => {
      console.warn(`[sashd] TUN guard reconcile failed: ${errorMessage(error)}`);
    });
  }

  private async startConfiguration(configuration: RuntimeConfiguration): Promise<CoreStartResult> {
    await this.requireVacantController();
    this.applied = undefined;
    await atomicWriteFile(this.options.layout.configFile, configuration.generated.yaml);
    this.runtimeSettings = { ...configuration.settings };
    const result = await this.startCore();
    this.applied = configuration;
    this.reconcileTunGuard(configuration);
    await this.reconcileSystemProxy();
    return result;
  }

  /**
   * Apply a configuration to the running Core without restarting it: the Core
   * swaps proxies, rules and DNS in place, so connections established before
   * the reload keep their current outbound. Sash does not request forced
   * listener rebinding, so port and LAN changes use the supervised restart
   * path instead; the Core controller is never changed by a reload.
   */
  async reload(
    configuration: RuntimeConfiguration,
    signal?: AbortSignal,
  ): Promise<CoreStartResult> {
    signal?.throwIfAborted();
    const applied = this.applied;
    if (!applied) throw new Error("Core configuration is unknown; apply it with a restart");
    if (!sameEffectiveTunSettings(applied.settings.tun, configuration.settings.tun))
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
    if (configuration.settings.tun.enable) this.reconcileTunGuard(configuration);
    await this.reconcileSystemProxy();
    return {
      pid: core.pid,
      ...(core.version ? { version: core.version } : {}),
      alreadyRunning: true,
      mixedPort: this.runtimeSettings.mixedPort,
    };
  }

  async stop(options: { final?: boolean } = {}): Promise<void> {
    await this.options.systemProxy.release();
    await this.options.supervisor.stop();
    this.runtimeRevision += 1;
    const guard = this.options.tunGuard;
    if (!options.final || !guard) return;
    const teardown = guard.reconcile("teardown", {});
    const timeout = new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 5_000);
      timer.unref?.();
    });
    const outcome = await Promise.race([
      teardown.then(
        () => "done" as const,
        (error: unknown) => {
          console.warn(`[sashd] TUN guard teardown failed: ${errorMessage(error)}`);
          return "done" as const;
        },
      ),
      timeout,
    ]);
    if (outcome === "timeout")
      console.warn("[sashd] TUN guard teardown did not finish within 5s; continuing shutdown");
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

  private async installStagedCoreInPlace(
    staged: StagedCore,
    configuration: RuntimeConfiguration,
    keepRunning: boolean,
  ): Promise<CoreUpdateResult> {
    if (!this.options.supervisor.isRunning()) {
      await atomicWriteFile(this.options.layout.configFile, configuration.generated.yaml);
      this.runtimeSettings = { ...configuration.settings };
    }
    return commitCoreUpdate({
      layout: this.options.layout,
      staged,
      runtime: {
        keepRunning,
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

  async update(
    staged: StagedCore,
    configuration: RuntimeConfiguration,
    startAfterInstall = false,
  ): Promise<CoreUpdateResult> {
    const wasRunning = this.options.supervisor.isRunning();
    if (!configuration.settings.tun.enable) {
      return this.installStagedCoreInPlace(staged, configuration, wasRunning || startAfterInstall);
    }

    const verification = verificationConfiguration(configuration);
    if (wasRunning) await this.stop();
    let result: CoreUpdateResult;
    try {
      result = await this.installStagedCoreInPlace(staged, verification, false);
    } catch (error) {
      if (wasRunning) {
        try {
          await this.apply(configuration);
        } catch (restartError) {
          throw new Error(
            `${errorMessage(error)}; TUN restart failed: ${errorMessage(restartError)}`,
          );
        }
      }
      throw error;
    }

    this.applied = undefined;
    if (wasRunning || startAfterInstall) {
      try {
        await this.apply(configuration);
      } catch (error) {
        throw new CoreUpdateResumeError(
          `Core updated to ${staged.version}, but TUN could not restart: ${errorMessage(error)}`,
          error,
        );
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

  async restoreCoreSession(expected: RuntimeConfiguration): Promise<void> {
    if (this.options.supervisor.isRunning()) return;
    const desired = this.options.settings();
    if (
      expected.settings.tun.enable &&
      !sameEffectiveTunSettings(desired.tun, expected.settings.tun)
    )
      return;
    await this.apply(expected);
    console.warn("[sashd] Core restarted after an unexpected exit");
  }

  private allowRecoveryCycle(): boolean {
    const now = Date.now();
    this.recoveryCycles = this.recoveryCycles.filter(
      (startedAt) => now - startedAt < CORE_RECOVERY_WINDOW_MS,
    );
    if (this.recoveryCycles.length >= CORE_RECOVERY_CYCLES_PER_WINDOW) return false;
    this.recoveryCycles.push(now);
    return true;
  }

  async restoreCoreSessionWithRetries(
    expected: RuntimeConfiguration,
    mutate: <T>(action: () => T | Promise<T>) => Promise<T>,
    closing: () => boolean,
    delays: readonly number[] = CORE_RESTORE_DELAYS_MS,
  ): Promise<void> {
    if (!this.allowRecoveryCycle()) {
      console.warn(
        "[sashd] Core recovery paused after repeated crashes; run sash restart after fixing the cause",
      );
      return;
    }
    for (let index = 0; index < delays.length; index += 1) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, delays[index]));
      if (closing()) return;
      try {
        await mutate(() => this.restoreCoreSession(expected));
        return;
      } catch (error) {
        if (closing()) return;
        console.warn(
          `[sashd] Core recovery failed (attempt ${index + 1}/${delays.length}): ${errorMessage(error)}`,
        );
      }
    }
    console.warn(
      "[sashd] Core did not recover; traffic is direct until sash restart or Apply succeeds",
    );
  }
}
