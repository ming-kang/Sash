import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SashStateStore, StateConflictError } from "../app-state.js";
import { type AutostartController, AutostartService } from "../autostart/service.js";
import {
  assertCoreInstallationConsistent,
  coreInstalled,
  currentCoreVersion,
  type StagedCore,
  stageCore,
} from "../core.js";
import {
  CONFIG_TEST_GEODATA_TIMEOUT_MS,
  isGeodataDownloadFailure,
  validateCoreConfig,
} from "../core-config-validation.js";
import {
  type CoreUpdateProgress,
  type CoreUpdateResult,
  type CoreUpdateStage,
  readCoreUpdateTransaction,
} from "../core-update.js";
import { errorMessage } from "../error-utils.js";
import { formatProxyFallbackWarning } from "../http.js";
import {
  GEOX_MIRROR_SETS,
  type GeneratedConfig,
  type SubscriptionFetch,
  withGeodataMirrors,
} from "../mihomo-config.js";
import { currentPackageRoot, readSashPackageInfo } from "../package-info.js";
import type { SashLayout } from "../paths.js";
import { ProfileService } from "../profile-service.js";
import { getActiveProfile, renderActiveConfig } from "../profiles.js";
import { type RuntimeConfiguration, RuntimeLifecycle } from "../runtime-lifecycle.js";
import type { SashSettings } from "../settings.js";
import { SettingsService } from "../settings-service.js";
import { CoreSupervisor } from "../supervisor.js";
import { type SystemProxyController, SystemProxyManager } from "../system-proxy-manager.js";
import { WebAuthManager } from "./auth.js";
import { type DaemonContext, DaemonGate } from "./context.js";
import { createEventObserver, DaemonEvents } from "./events.js";
import type { DaemonScheduler } from "./scheduler.js";

export interface DaemonDeps {
  layout: SashLayout;
  packageRoot?: string;
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
  const packageRoot = deps.packageRoot ?? currentPackageRoot();
  const packageInfo = readSashPackageInfo(packageRoot);
  const state = deps.state ?? new SashStateStore(layout, deps.settings);
  const settings = () => state.snapshot().settings;
  const token = deps.token ?? crypto.randomBytes(24).toString("hex");
  const systemProxy = deps.systemProxy ?? new SystemProxyManager({ layout });
  let lifecycle: RuntimeLifecycle;
  let gate: DaemonGate;
  const events = new DaemonEvents(createEventObserver(() => context));
  const supervisor =
    deps.supervisor ??
    new CoreSupervisor({
      layout,
      settings: () => lifecycle?.settings() ?? settings(),
      onExit: () =>
        gate
          .mutate(() => lifecycle.handleUnexpectedCoreExit())
          .catch((error: unknown) => {
            console.error(`[sashd] Core exit cleanup failed: ${errorMessage(error)}`);
          }),
    });
  lifecycle = new RuntimeLifecycle({
    layout,
    supervisor,
    systemProxy,
    settings,
    controllerProbe: deps.controllerProbe,
  });
  let downloading = false;
  let coreUpdateProgress: CoreUpdateProgress | null = null;
  let preparation = new AbortController();
  let profiles: ProfileService;
  const cancelCorePreparation = (): void => {
    preparation.abort(new StateConflictError("Core operation cancelled"));
    preparation = new AbortController();
  };
  const cancelPreparations = (): void => {
    cancelCorePreparation();
    profiles.cancelDownloads();
  };
  gate = new DaemonGate(() => lifecycle.stop(), cancelPreparations, {
    onChange: () => events.notify(),
  });
  const mutate = <T>(action: () => T | Promise<T>) => gate.mutate(action);
  profiles = new ProfileService({
    layout,
    state,
    canCleanTemp: () => !downloading,
    commit: mutate,
    assertMutable: () => gate.assertMutable(),
    fetchProfile: deps.fetchProfileFn,
  });
  const settingsService = new SettingsService({ state, commit: mutate, lifecycle, supervisor });
  const validate = (
    generated: GeneratedConfig,
    executable: string,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<void> => {
    return Promise.resolve(
      deps.validateConfigFn
        ? deps.validateConfigFn(generated, executable, signal)
        : validateCoreConfig(executable, generated.yaml, layout, {
            signal,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          }),
    );
  };

  /**
   * Validate a configuration, and if the Core failed only because it could not
   * download its geodata databases, retry through each mirror set. The Core
   * fetches geodata from github.com by default and cannot use the proxy it has
   * not started yet, which would otherwise deadlock a fresh installation on a
   * network that cannot reach github.com directly. Mirror attempts get a
   * longer budget: downloading tens of megabytes takes more than the plain
   * configuration test's timeout.
   */
  const validateConfiguration = async (
    configuration: RuntimeConfiguration,
    executable: string,
    signal: AbortSignal,
  ): Promise<RuntimeConfiguration> => {
    try {
      await validate(configuration.generated, executable, signal);
      return configuration;
    } catch (error) {
      if (!isGeodataDownloadFailure(error)) throw error;
      const seen = new Set([configuration.generated.yaml]);
      let lastError = error;
      for (let index = 0; index < GEOX_MIRROR_SETS.length; index += 1) {
        const retried: RuntimeConfiguration = {
          ...configuration,
          generated: withGeodataMirrors(configuration.generated, index),
        };
        // The configuration may already fetch through this mirror set.
        if (seen.has(retried.generated.yaml)) continue;
        seen.add(retried.generated.yaml);
        const host = new URL(GEOX_MIRROR_SETS[index]?.geoip ?? "").host;
        console.warn(`[sashd] geodata download failed; retrying through mirror ${host}`);
        try {
          await validate(retried.generated, executable, signal, CONFIG_TEST_GEODATA_TIMEOUT_MS);
          return retried;
        } catch (mirrorError) {
          if (!isGeodataDownloadFailure(mirrorError)) throw mirrorError;
          lastError = mirrorError;
        }
      }
      throw lastError;
    }
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

  const updateCore = async (
    version?: string,
    startAfterInstall = false,
  ): Promise<CoreUpdateResult> => {
    gate.assertMutable();
    if (downloading) throw new StateConflictError("A Core download is already in progress");
    requireRecoveredInstall();
    const { signal } = preparation;
    downloading = true;
    const progress: CoreUpdateProgress = {
      stage: "checking",
      startedAt: new Date().toISOString(),
      target: version ?? null,
      downloading: false,
      downloaded: 0,
      total: null,
    };
    coreUpdateProgress = progress;
    events.notify();
    const setStage = (stage: CoreUpdateStage, target?: string): void => {
      progress.stage = stage;
      progress.downloading = stage === "downloading";
      if (target) progress.target = target;
      events.notify();
    };
    let staged: StagedCore | undefined;
    try {
      signal.throwIfAborted();
      requireRecoveredInstall();
      const revision = state.snapshot().revision;
      const epoch = lifecycle.revision;
      const configuration = supervisor.isRunning()
        ? lifecycle.configuration()
        : savedConfiguration();
      if (!configuration) throw new Error("Running Core configuration is unknown");
      setStage("resolving");
      staged = await (deps.stageCoreFn ?? stageCore)({
        layout,
        tag: version,
        signal,
        onStage: setStage,
        onProgress: (downloaded, total) => {
          progress.downloaded = downloaded;
          progress.total = total ?? null;
          events.notify();
        },
        onProxyFallback: (info) => {
          const warning = formatProxyFallbackWarning(info);
          progress.note = warning;
          events.notify();
          console.warn(`[sashd] ${warning}`);
        },
      });
      signal.throwIfAborted();
      setStage("validating", staged.version);
      const validated = await validateConfiguration(configuration, staged.exe, signal);
      const candidate = staged;
      setStage("waiting");
      return await mutate(async () => {
        signal.throwIfAborted();
        state.assertCurrent(revision);
        if (lifecycle.revision !== epoch)
          throw new StateConflictError("Core changed during download; retry the update");
        setStage("installing");
        return lifecycle.update(candidate, validated, startAfterInstall);
      });
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      downloading = false;
      coreUpdateProgress = null;
      events.notify();
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
    gate.assertMutable();
    const { signal } = preparation;
    requireRecoveredInstall();
    signal.throwIfAborted();
    const installedNow = !coreInstalled(layout);
    if (installedNow) await updateCore(undefined, true);
    return mutate(async () => {
      signal.throwIfAborted();
      requireRecoveredInstall();
      if (installedNow) {
        const owner = supervisor.ownedCoreSnapshot();
        if (!owner) throw new Error("Core exited after installation");
        return {
          pid: owner.pid,
          version: currentCoreVersion(layout),
          alreadyRunning: false,
          mixedPort: lifecycle.settings().mixedPort,
        };
      }
      if (onlyIfStopped && supervisor.isRunning()) return lifecycle.start();
      const configuration = savedConfiguration();
      const validated = await validateConfiguration(configuration, layout.coreExe, signal);
      signal.throwIfAborted();
      return lifecycle.apply(validated);
    });
  };

  const context: DaemonContext = {
    layout,
    state,
    token,
    startedAt: new Date().toISOString(),
    version: packageInfo.version,
    webAuth: new WebAuthManager(layout.webSessionsFile),
    profiles,
    settingsService,
    lifecycle,
    supervisor,
    get coreUpdate() {
      return coreUpdateProgress ? { ...coreUpdateProgress } : null;
    },
    systemProxy,
    autostart: deps.autostart ?? new AutostartService({ layout }),
    gate,
    events,
    mutate,
    settings: { committed: settings, runtime: () => lifecycle.settings() },
    stateRevision: () => state.snapshot().revision,
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
      cancelCorePreparation();
      return mutate(() => lifecycle.stop());
    },
    shutdown: () => gate.shutdown(),
    closeListener: () => Promise.reject(new Error("Listener is not ready")),
    ...(deps.onShutdown ? { onShutdown: deps.onShutdown } : {}),
  };
  return { context, supervisor, lifecycle, token };
}
