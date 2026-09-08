import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SashStateStore, StateConflictError } from "../app-state.js";
import { type AutostartController, AutostartService } from "../autostart.js";
import {
  assertCoreInstallationConsistent,
  coreInstalled,
  currentCoreVersion,
  type StagedCore,
  stageCore,
} from "../core.js";
import { validateCoreConfig } from "../core-config-validation.js";
import { readInstallRecord } from "../core-install-record.js";
import { ensureCoreIntegrityRecords } from "../core-install-verification.js";
import { assertCoreBinaryDigest } from "../core-integrity.js";
import { type CoreUpdateResult, readCoreUpdateTransaction } from "../core-update.js";
import type { GeneratedConfig, SubscriptionFetch } from "../mihomo-config.js";
import type { SashLayout } from "../paths.js";
import { ProfileService } from "../profile-service.js";
import { getActiveProfile, renderActiveConfig } from "../profiles.js";
import { type RuntimeConfiguration, RuntimeLifecycle } from "../runtime-lifecycle.js";
import type { SashSettings } from "../settings.js";
import { SettingsService } from "../settings-service.js";
import { CoreSupervisor } from "../supervisor.js";
import { type SystemProxyController, SystemProxyManager } from "../system-proxy-manager.js";
import { type DaemonContext, DaemonGate } from "./context.js";
import type { DaemonScheduler } from "./scheduler.js";
import { WebAuthManager } from "./web-auth.js";

export interface DaemonDeps {
  layout: SashLayout;
  state?: SashStateStore;
  settings?: SashSettings;
  supervisor?: CoreSupervisor;
  systemProxy?: SystemProxyController;
  autostart?: AutostartController;
  token?: string;
  fetchProfileFn?: (url: string, signal?: AbortSignal) => Promise<SubscriptionFetch>;
  validateConfigFn?: (
    generated: GeneratedConfig,
    executable: string,
    signal: AbortSignal,
  ) => Promise<void> | void;
  stageCoreFn?: typeof stageCore;
  verifyCoreFn?: (exe: string, version: string) => void;
  controllerProbe?: (settings: SashSettings) => Promise<boolean>;
  onShutdown?: () => void;
  scheduler?: DaemonScheduler;
}

export interface DaemonApp {
  context: DaemonContext;
  supervisor: CoreSupervisor;
  lifecycle: RuntimeLifecycle;
  token: string;
}

/** The daemon owns all application writes; CLI and WebUI use the same actions. */
export function buildDaemonContext(deps: DaemonDeps): DaemonApp {
  const { layout } = deps;
  const state = deps.state ?? new SashStateStore(layout, deps.settings);
  const settings = () => state.snapshot().settings;
  const token = deps.token ?? crypto.randomBytes(24).toString("hex");
  const systemProxy = deps.systemProxy ?? new SystemProxyManager({ layout });
  let lifecycle: RuntimeLifecycle;
  let gate: DaemonGate;
  const supervisor =
    deps.supervisor ??
    new CoreSupervisor({
      layout,
      settings: () => lifecycle?.settings() ?? settings(),
      expectedVersion: () => currentCoreVersion(layout) || undefined,
      onExit: () =>
        gate
          .mutate("recover Core exit", () => lifecycle.handleUnexpectedCoreExit())
          .catch((error: unknown) => {
            console.error(
              `[sashd] Core exit cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }),
    });
  lifecycle = new RuntimeLifecycle({
    layout,
    supervisor,
    systemProxy,
    settings,
    verifyExecutable: deps.verifyCoreFn,
    controllerProbe: deps.controllerProbe,
  });
  let downloading = false;
  let verifyingIntegrity: Promise<void> | undefined;
  let preparation = new AbortController();
  let profiles: ProfileService;
  const cancelPreparations = (): void => {
    preparation.abort(new StateConflictError("Core operation cancelled"));
    preparation = new AbortController();
    profiles.cancelDownloads();
  };
  gate = new DaemonGate(() => lifecycle.stop(), cancelPreparations);
  const mutate = <T>(purpose: string, action: () => T | Promise<T>) => gate.mutate(purpose, action);
  profiles = new ProfileService({
    layout,
    state,
    commit: mutate,
    fetchProfile: deps.fetchProfileFn,
  });
  const settingsService = new SettingsService({ state, commit: mutate, lifecycle, supervisor });
  const validate = (
    generated: GeneratedConfig,
    executable: string,
    signal: AbortSignal,
    sha256 = readInstallRecord(layout)?.sha256,
  ): Promise<void> => {
    assertCoreBinaryDigest(executable, sha256);
    return Promise.resolve(
      deps.validateConfigFn
        ? deps.validateConfigFn(generated, executable, signal)
        : validateCoreConfig(executable, generated.yaml, layout, { signal }),
    );
  };

  const savedConfiguration = (): RuntimeConfiguration => {
    const snapshot = state.snapshot();
    const profile = getActiveProfile(snapshot.profiles);
    return {
      generated: renderActiveConfig(snapshot, layout),
      settings: snapshot.settings,
      profile: profile
        ? { id: profile.id, revision: profile.revision, name: profile.name, url: profile.url }
        : null,
    };
  };

  const requireRecoveredInstall = (): void => {
    assertCoreInstallationConsistent(layout);
    if (readCoreUpdateTransaction(layout))
      throw new StateConflictError(
        "Core update recovery is pending; run sash stop, then sash start",
      );
  };

  const verifyInstalledIntegrity = (): Promise<void> => {
    const { signal } = preparation;
    verifyingIntegrity ??= ensureCoreIntegrityRecords(
      layout,
      (tag) => (deps.stageCoreFn ?? stageCore)({ layout, tag, signal }),
      signal,
    ).finally(() => {
      verifyingIntegrity = undefined;
    });
    return verifyingIntegrity;
  };

  const updateCore = async (version?: string): Promise<CoreUpdateResult> => {
    if (gate.isClosing) throw new Error("sashd is shutting down");
    if (downloading) throw new StateConflictError("A Core download is already in progress");
    requireRecoveredInstall();
    const { signal } = preparation;
    downloading = true;
    let staged: StagedCore | undefined;
    try {
      await verifyInstalledIntegrity();
      signal.throwIfAborted();
      requireRecoveredInstall();
      const revision = state.snapshot().revision;
      const epoch = lifecycle.revision;
      const configuration = supervisor.isRunning()
        ? lifecycle.configuration()
        : savedConfiguration();
      if (!configuration) throw new Error("Running Core configuration is unknown");
      staged = await (deps.stageCoreFn ?? stageCore)({ layout, tag: version, signal });
      signal.throwIfAborted();
      await validate(configuration.generated, staged.exe, signal, staged.sha256);
      const candidate = staged;
      return await mutate("update Core", async () => {
        signal.throwIfAborted();
        state.assertCurrent(revision);
        if (lifecycle.revision !== epoch)
          throw new StateConflictError("Core changed during download; retry the update");
        return lifecycle.update(candidate, configuration);
      });
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      downloading = false;
      if (staged) {
        fs.rmSync(staged.exe, { force: true });
        try {
          fs.rmdirSync(path.dirname(staged.exe));
        } catch {
          /* Only remove an empty staging directory. */
        }
      }
    }
  };

  const applyCore = async (onlyIfStopped = false) => {
    const { signal } = preparation;
    requireRecoveredInstall();
    await verifyInstalledIntegrity();
    signal.throwIfAborted();
    if (!coreInstalled(layout)) await updateCore();
    return mutate("apply saved configuration", async () => {
      signal.throwIfAborted();
      requireRecoveredInstall();
      if (onlyIfStopped && supervisor.isRunning()) return lifecycle.start();
      const configuration = savedConfiguration();
      await validate(configuration.generated, layout.coreExe, signal);
      signal.throwIfAborted();
      return lifecycle.apply(configuration);
    });
  };

  const context: DaemonContext = {
    layout,
    state,
    token,
    startedAt: new Date().toISOString(),
    webAuth: new WebAuthManager(),
    profiles,
    settingsService,
    lifecycle,
    supervisor,
    systemProxy,
    autostart: deps.autostart ?? new AutostartService({ layout }),
    gate,
    mutate,
    settings: { committed: settings, runtime: () => lifecycle.settings() },
    profileRevision: () => state.snapshot().revision,
    pendingApply: () => {
      const saved = state.snapshot();
      const active = getActiveProfile(saved.profiles);
      const applied = lifecycle.configuration();
      return (
        !applied ||
        applied.profile?.id !== active?.id ||
        applied.profile?.revision !== active?.revision ||
        applied.settings.mixedPort !== saved.settings.mixedPort ||
        applied.settings.allowLan !== saved.settings.allowLan
      );
    },
    startCore: () => applyCore(true),
    restartCore: () => applyCore(),
    updateCore,
    stopCore: () => {
      cancelPreparations();
      return mutate("stop Core", () => lifecycle.stop());
    },
    shutdown: () => gate.shutdown(),
    closeListener: () => Promise.reject(new Error("Listener is not ready")),
    ...(deps.onShutdown ? { onShutdown: deps.onShutdown } : {}),
  };
  return { context, supervisor, lifecycle, token };
}
