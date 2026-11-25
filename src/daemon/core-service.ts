import fs from "node:fs";
import YAML from "yaml";
import { type SashState, type SashStateStore, StateConflictError } from "../app-state.js";
import type {
  ConfigurationPendingChanges,
  CoreApplyMethod,
  CoreStartResult,
} from "../contracts.js";
import {
  assertCoreInstallationConsistent,
  coreInstalled,
  currentCoreVersion,
  resolveCoreRelease,
  type StagedCore,
  stageCore,
} from "../core.js";
import {
  type CoreUpdateCheck,
  type CoreUpdateProgress,
  type CoreUpdateResult,
  type CoreUpdateStage,
  checkCoreUpdate,
  readCoreUpdateTransaction,
} from "../core-update.js";
import type { CoreEngine } from "../engine/index.js";
import { errorMessage, withErrorPresentation } from "../error-utils.js";
import { type GeodataSeedResult, seedGeodataFile } from "../geodata-seed.js";
import { type DownloadTransport, envProxyUri, formatProxyFallbackWarning } from "../http.js";
import { countProxies, ensureGlobalGroup, type GeneratedConfig } from "../mihomo-config.js";
import type { SashLayout } from "../paths.js";
import type { PluginGenerateContext } from "../plugins/index.js";
import { renderActiveConfig } from "../profile-service.js";
import { renderGeodataMirrorsOffThread } from "../profile-work.js";
import { getActiveProfile } from "../profiles.js";
import type {
  RuntimeConfiguration,
  RuntimeLifecycle,
  RuntimeTarget,
} from "../runtime-lifecycle.js";
import { CoreStartError, runtimeDelta } from "../runtime-lifecycle.js";
import { publicSettings } from "../settings.js";
import type { CoreState, CoreSupervisor } from "../supervisor.js";
import { enforceTunConfiguration } from "../tun-config.js";
import type { TunSettings } from "../tun-settings.js";
import { disabledTun, sameEffectiveTunSettings } from "../tun-settings.js";

export interface CoreControlServiceOptions {
  layout: SashLayout;
  state: SashStateStore;
  engine: CoreEngine;
  supervisor: CoreSupervisor;
  lifecycle: RuntimeLifecycle;
  commit: <T>(action: () => T | Promise<T>) => Promise<T>;
  assertMutable: () => void;
  onProgress: () => void;
  validateConfigFn?: (
    generated: GeneratedConfig,
    executable: string,
    signal: AbortSignal,
  ) => Promise<void> | void;
  stageCoreFn?: typeof stageCore;
  resolveCoreReleaseFn?: typeof resolveCoreRelease;
  seedGeodataFn?: (
    file: string,
    options: { signal: AbortSignal; proxyUri?: string },
  ) => Promise<GeodataSeedResult>;
  plugins?: {
    hasGenerateHooks(): Promise<boolean>;
    applyGenerated(
      config: Record<string, unknown>,
      context: PluginGenerateContext,
    ): Promise<Record<string, unknown>>;
  };
}

const PROGRESS_NOTIFY_INTERVAL_MS = 250;

interface ConfigurationPlan {
  snapshot: SashState;
  epoch: number;
}

type StartConfigurationCapture =
  | { kind: "running"; result: CoreStartResult }
  | { kind: "plan"; plan: ConfigurationPlan };

export class CoreControlService {
  private validationTail: Promise<void> = Promise.resolve();
  private preparation = new AbortController();
  private operation: CoreUpdateProgress | null = null;
  private lastProgressNotify = 0;

  private readonly engine: CoreEngine;

  constructor(private readonly options: CoreControlServiceOptions) {
    this.engine = options.engine;
  }

  get progress(): CoreUpdateProgress | null {
    return this.operation ? { ...this.operation } : null;
  }

  get isUpdating(): boolean {
    return this.operation !== null;
  }

  get pendingApply(): boolean {
    return runtimeDelta(this.options.lifecycle.configuration(), this.savedTarget()).pending;
  }

  configurationState(core: CoreState): {
    pending: boolean;
    pendingChanges: ConfigurationPendingChanges;
    applyMethod: CoreApplyMethod;
  } {
    const applied = this.options.lifecycle.configuration();
    const delta = runtimeDelta(applied, this.savedTarget());
    const applyMethod: CoreApplyMethod = !core.running
      ? "start"
      : applied && !delta.restartRequired && core.healthy === true
        ? "reload"
        : "restart";
    return { pending: delta.pending, pendingChanges: delta.pendingChanges, applyMethod };
  }

  downloadTransport(): DownloadTransport | null {
    const environment = envProxyUri();
    if (environment) return { uri: environment, source: "environment" };
    if (!this.options.supervisor.isRunning()) return null;
    return {
      uri: `http://127.0.0.1:${this.options.lifecycle.settings().mixedPort}`,
      source: "core",
    };
  }

  cancelPreparation(): void {
    this.preparation.abort(new StateConflictError("Core download cancelled"));
    this.preparation = new AbortController();
  }

  cancel(): void {
    if (!this.operation) throw new StateConflictError("No Core download is in progress");
    this.cancelPreparation();
    this.operation = null;
    this.options.onProgress();
  }

  private publishProgress(immediate = false): void {
    const now = Date.now();
    if (!immediate && now - this.lastProgressNotify < PROGRESS_NOTIFY_INTERVAL_MS) return;
    this.lastProgressNotify = now;
    this.options.onProgress();
  }

  private validate(
    generated: GeneratedConfig,
    executable: string,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<void> {
    return Promise.resolve(
      this.options.validateConfigFn
        ? this.options.validateConfigFn(generated, executable, signal)
        : this.engine.validateConfig(executable, generated.yaml, this.options.layout, {
            signal,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          }),
    );
  }

  /**
   * Retry a configuration through each geodata mirror set when the Core failed
   * only on its geodata download: Core fetches geodata from github.com by
   * default and cannot use the proxy it has not started yet, which would
   * otherwise deadlock a fresh installation on such a network. Mirror attempts
   * get the geodata budget, not the plain configuration test's timeout.
   */
  private validateConfiguration(
    configuration: RuntimeConfiguration,
    executable: string,
    signal: AbortSignal,
    proxyUri?: string,
  ): Promise<RuntimeConfiguration> {
    const next = this.validationTail.then(() => {
      signal.throwIfAborted();
      return this.validateConfigurationNow(configuration, executable, signal, proxyUri);
    });
    this.validationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async validateConfigurationNow(
    configuration: RuntimeConfiguration,
    executable: string,
    signal: AbortSignal,
    proxyUri?: string,
  ): Promise<RuntimeConfiguration> {
    const seedGeodata =
      this.options.seedGeodataFn ??
      ((file: string, options: { signal: AbortSignal; proxyUri?: string }) =>
        seedGeodataFile(file, this.options.layout, options));
    try {
      await this.validate(configuration.generated, executable, signal);
      return configuration;
    } catch (error) {
      if (!this.engine.geodata.isDownloadFailure(error)) throw error;
      const seen = new Set([configuration.generated.yaml]);
      let lastError = error;
      for (const mirrors of this.engine.geodata.mirrorSets) {
        const retried: RuntimeConfiguration = {
          ...configuration,
          generated: await renderGeodataMirrorsOffThread(configuration.generated, mirrors),
        };
        if (seen.has(retried.generated.yaml)) continue;
        seen.add(retried.generated.yaml);
        const host = new URL(mirrors.geoip).host;
        console.warn(`[sashd] geodata download failed; retrying through mirror ${host}`);
        try {
          await this.validate(
            retried.generated,
            executable,
            signal,
            this.engine.geodata.testTimeoutMs,
          );
          return retried;
        } catch (mirrorError) {
          if (!this.engine.geodata.isDownloadFailure(mirrorError)) throw mirrorError;
          lastError = mirrorError;
        }
      }
      // The Core skips downloads for files already in the data folder.
      const seeded = new Set<string>();
      for (;;) {
        const file = this.engine.geodata.fileForFailure(lastError);
        if (!file || seeded.has(file)) break;
        seeded.add(file);
        try {
          const result = await seedGeodata(file, {
            signal,
            ...(proxyUri !== undefined ? { proxyUri } : {}),
          });
          console.warn(
            `[sashd] installed verified geodata file ${result.file}${result.source === "pinned" ? " from the packaged bootstrap manifest" : ""}`,
          );
        } catch (seedError) {
          signal.throwIfAborted();
          console.warn(`[sashd] verified geodata download failed: ${errorMessage(seedError)}`);
          break;
        }
        try {
          await this.validate(configuration.generated, executable, signal);
          return configuration;
        } catch (retryError) {
          if (!this.engine.geodata.isDownloadFailure(retryError)) throw retryError;
          lastError = retryError;
        }
      }
      throw lastError;
    }
  }

  private async applyGeneratePlugins(
    generated: GeneratedConfig,
    context: PluginGenerateContext,
  ): Promise<GeneratedConfig> {
    const plugins = this.options.plugins;
    const hooksInstalled = plugins !== undefined && (await plugins.hasGenerateHooks());
    if (!hooksInstalled) return generated;
    const document = YAML.parse(generated.yaml) as Record<string, unknown>;
    const patched = await plugins.applyGenerated(document, context);
    const warnings = [...(generated.warnings ?? [])];
    ensureGlobalGroup(patched);
    enforceTunConfiguration(patched, context.settings.tun, warnings);
    return {
      yaml: YAML.stringify(patched, { indent: 2 }),
      proxyCount: countProxies(patched),
      source: generated.source,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  private async savedConfiguration(
    snapshot = this.options.state.snapshot(),
  ): Promise<RuntimeConfiguration> {
    const profile = getActiveProfile(snapshot.profiles);
    const meta = profile
      ? { id: profile.id, revision: profile.revision, name: profile.name, url: profile.url }
      : null;
    const generated = await renderActiveConfig(snapshot, this.options.layout);
    const finalConfig = await this.applyGeneratePlugins(generated, {
      settings: publicSettings(snapshot.settings),
      profile: meta,
      source: generated.source,
    });
    for (const warning of finalConfig.warnings ?? []) console.warn(`[sashd] ${warning}`);
    return {
      generated: finalConfig,
      settings: snapshot.settings,
      profile: meta,
    };
  }

  private requireRecoveredInstall(): void {
    assertCoreInstallationConsistent(this.options.layout);
    if (readCoreUpdateTransaction(this.options.layout))
      throw new StateConflictError(
        "Core update recovery is pending; run sash stop, then sash start",
      );
  }

  private savedTarget(snapshot = this.options.state.snapshot()): RuntimeTarget {
    return { profile: getActiveProfile(snapshot.profiles), settings: snapshot.settings };
  }

  private configurationPlan(): ConfigurationPlan {
    return { snapshot: this.options.state.snapshot(), epoch: this.options.lifecycle.revision };
  }

  private captureConfigurationPlan(signal: AbortSignal): Promise<ConfigurationPlan> {
    return this.options.commit(async () => {
      signal.throwIfAborted();
      this.requireRecoveredInstall();
      return this.configurationPlan();
    });
  }

  private captureStartConfiguration(signal: AbortSignal): Promise<StartConfigurationCapture> {
    return this.options.commit(async () => {
      signal.throwIfAborted();
      this.requireRecoveredInstall();
      if (this.options.supervisor.isRunning())
        return { kind: "running", result: await this.options.lifecycle.start() };
      return { kind: "plan", plan: this.configurationPlan() };
    });
  }

  private async prepareValidatedConfiguration(
    plan: ConfigurationPlan,
    signal: AbortSignal,
    proxyUri?: string,
  ): Promise<RuntimeConfiguration> {
    const configuration = await this.savedConfiguration(plan.snapshot);
    return this.validateConfiguration(configuration, this.options.layout.coreExe, signal, proxyUri);
  }

  private async runExplicitConfiguration(
    plan: ConfigurationPlan,
    signal: AbortSignal,
    commit: (configuration: RuntimeConfiguration) => Promise<CoreStartResult>,
  ): Promise<CoreStartResult> {
    const validated = await this.prepareValidatedConfiguration(
      plan,
      signal,
      this.downloadTransport()?.uri,
    );
    return this.withTunStartFailureRollback(plan.snapshot, signal, () => commit(validated));
  }

  private assertPlanCurrent(configuration: RuntimeConfiguration, plan: ConfigurationPlan): void {
    this.assertCurrentConfiguration(configuration);
    if (this.options.lifecycle.revision !== plan.epoch)
      throw new StateConflictError("Core changed during preparation; retry Apply");
  }

  private async applyValidatedConfiguration(
    configuration: RuntimeConfiguration,
    signal: AbortSignal,
  ): Promise<CoreStartResult> {
    if (await this.canReload(configuration))
      return this.options.lifecycle.reload(configuration, signal);
    return this.options.lifecycle.apply(configuration);
  }

  private assertCurrentConfiguration(configuration: RuntimeConfiguration): void {
    if (runtimeDelta(configuration, this.savedTarget()).pending)
      throw withErrorPresentation(
        new StateConflictError("Saved configuration changed during preparation; retry Apply"),
        {
          message: "The saved configuration changed during preparation.",
          advice: "Run sash restart to apply the current configuration.",
        },
      );
  }

  checkUpdate(): Promise<CoreUpdateCheck> {
    this.options.assertMutable();
    if (this.operation)
      throw new StateConflictError(
        "A Core download is already in progress — wait for it to finish, or cancel it with sash update --cancel",
      );
    const pinnedProxyUri = this.downloadTransport()?.uri;
    return checkCoreUpdate(this.options.layout, {
      ...(pinnedProxyUri !== undefined ? { proxyUri: pinnedProxyUri } : {}),
      onProxyFallback: (info) => console.warn(`[sashd] ${formatProxyFallbackWarning(info)}`),
    });
  }

  async update(version?: string, startAfterInstall = false): Promise<CoreUpdateResult> {
    const { layout, supervisor, lifecycle } = this.options;
    this.options.assertMutable();
    if (this.operation)
      throw new StateConflictError(
        "A Core download is already in progress — wait for it to finish, or cancel it with sash update --cancel",
      );
    this.requireRecoveredInstall();
    const { signal } = this.preparation;
    const pinnedProxyUri = this.downloadTransport()?.uri;
    const progress: CoreUpdateProgress = {
      stage: "checking",
      startedAt: new Date().toISOString(),
      target: version ?? null,
      downloading: false,
      downloaded: 0,
      total: null,
    };
    this.operation = progress;
    this.options.onProgress();
    const setStage = (stage: CoreUpdateStage, target?: string): void => {
      progress.stage = stage;
      progress.downloading = stage === "downloading";
      if (target) progress.target = target;
      this.publishProgress(true);
    };
    let staged: StagedCore | undefined;
    try {
      signal.throwIfAborted();
      this.requireRecoveredInstall();
      const epoch = lifecycle.revision;
      const wasRunning = supervisor.isRunning();
      const configuration = wasRunning
        ? lifecycle.configuration()
        : await this.savedConfiguration();
      if (!configuration) throw new Error("Running Core configuration is unknown");
      setStage("resolving");
      const release = await (this.options.resolveCoreReleaseFn ?? resolveCoreRelease)({
        ...(version !== undefined ? { tag: version } : {}),
        signal,
        ...(pinnedProxyUri !== undefined ? { proxyUri: pinnedProxyUri } : {}),
        onProxyFallback: (info) => {
          const warning = formatProxyFallbackWarning(info);
          progress.note = warning;
          this.publishProgress(true);
          console.warn(`[sashd] ${warning}`);
        },
      });
      signal.throwIfAborted();
      if (release.tag === currentCoreVersion(layout)) {
        progress.target = release.tag;
        return { version: release.tag, alreadyCurrent: true };
      }
      staged = await (this.options.stageCoreFn ?? stageCore)({
        layout,
        release,
        signal,
        ...(pinnedProxyUri !== undefined ? { proxyUri: pinnedProxyUri } : {}),
        onStage: setStage,
        onProgress: (downloaded, total) => {
          if (this.operation !== progress) return;
          progress.downloaded = downloaded;
          progress.total = total ?? null;
          this.publishProgress();
        },
      });
      signal.throwIfAborted();
      setStage("validating", staged.version);
      if (staged.source === "pinned") {
        const note = `pinned offline Core ${staged.version} — run sash update when GitHub is reachable`;
        progress.note = note;
        this.publishProgress(true);
        console.warn(`[sashd] ${note}`);
      }
      const validated = await this.validateConfiguration(
        configuration,
        staged.exe,
        signal,
        pinnedProxyUri,
      );
      const candidate = staged;
      setStage("waiting");
      return await this.options.commit(async () => {
        signal.throwIfAborted();
        const installedOverStoppedCore = !wasRunning;
        if (installedOverStoppedCore) this.assertCurrentConfiguration(validated);
        if (lifecycle.revision !== epoch)
          throw new StateConflictError("Core changed during download; retry the update");
        setStage("installing");
        return lifecycle.update(candidate, validated, startAfterInstall);
      });
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      if (this.operation === progress) {
        this.operation = null;
        this.options.onProgress();
      }
      if (staged) fs.rmSync(staged.dir, { recursive: true, force: true });
    }
  }

  async apply(): Promise<CoreStartResult> {
    this.options.assertMutable();
    const { signal } = this.preparation;
    this.requireRecoveredInstall();
    signal.throwIfAborted();
    if (!coreInstalled(this.options.layout)) return this.installAndStart(signal);

    const plan = await this.captureConfigurationPlan(signal);
    return this.runExplicitConfiguration(plan, signal, (validated) =>
      this.options.commit(async () => {
        signal.throwIfAborted();
        this.requireRecoveredInstall();
        this.assertPlanCurrent(validated, plan);
        return this.applyValidatedConfiguration(validated, signal);
      }),
    );
  }

  async start(): Promise<CoreStartResult> {
    this.options.assertMutable();
    const { lifecycle, supervisor } = this.options;
    const { signal } = this.preparation;
    this.requireRecoveredInstall();
    signal.throwIfAborted();
    if (!coreInstalled(this.options.layout)) return this.installAndStart(signal);

    const captured = await this.captureStartConfiguration(signal);
    if (captured.kind === "running") return captured.result;
    const { plan } = captured;
    return this.runExplicitConfiguration(plan, signal, (validated) =>
      this.options.commit(async () => {
        signal.throwIfAborted();
        this.requireRecoveredInstall();
        if (supervisor.isRunning()) return lifecycle.start();
        this.assertPlanCurrent(validated, plan);
        return this.applyValidatedConfiguration(validated, signal);
      }),
    );
  }

  async reconcileSaved(): Promise<boolean> {
    this.options.assertMutable();
    if (this.isUpdating || this.preparation.signal.aborted) return false;
    const { lifecycle } = this.options;
    const { signal } = this.preparation;
    try {
      const plan = this.configurationPlan();
      const target = this.savedTarget(plan.snapshot);
      if (
        !runtimeDelta(lifecycle.configuration(), target).pending ||
        !(await this.canReload(target))
      )
        return false;

      const validated = await this.prepareValidatedConfiguration(plan, signal);
      const result = await this.options.commit(async () => {
        signal.throwIfAborted();
        this.assertCurrentConfiguration(validated);
        if (lifecycle.revision !== plan.epoch) return undefined;
        if (!(await this.canReload(validated))) return undefined;
        return lifecycle.reload(validated, signal);
      });
      return result !== undefined;
    } catch (error) {
      console.warn(`[sashd] saved configuration was not applied: ${errorMessage(error)}`);
      return false;
    }
  }

  private async installAndStart(signal: AbortSignal): Promise<CoreStartResult> {
    const { layout, lifecycle, supervisor } = this.options;
    const snapshot = this.options.state.snapshot();
    await this.withTunStartFailureRollback(snapshot, signal, () => this.update(undefined, true));
    return this.options.commit(() => {
      signal.throwIfAborted();
      const owner = supervisor.ownedCoreSnapshot();
      if (!owner) throw new Error("Core exited after installation");
      return {
        pid: owner.pid,
        version: currentCoreVersion(layout),
        alreadyRunning: false,
        mixedPort: lifecycle.settings().mixedPort,
      };
    });
  }

  private async withTunStartFailureRollback<T>(
    snapshot: SashState,
    signal: AbortSignal,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof CoreStartError && !signal.aborted) {
        const tun = error.restored?.settings.tun ?? disabledTun(snapshot.settings.tun);
        if (!sameEffectiveTunSettings(tun, snapshot.settings.tun)) {
          await this.rollBackTunPreference(snapshot.revision, tun, error);
        }
      }
      throw error;
    }
  }

  private async rollBackTunPreference(
    revision: number,
    tun: TunSettings,
    error: unknown,
  ): Promise<void> {
    try {
      await this.options.commit(async () => {
        const state = this.options.state.snapshot();
        if (state.revision === revision) {
          await this.options.state.commitAsync({ ...state, settings: { ...state.settings, tun } });
        }
      });
    } catch (rollbackError) {
      throw new Error(
        `${errorMessage(error)}; could not roll back TUN settings: ${errorMessage(rollbackError)}`,
      );
    }
  }

  private async canReload(target: RuntimeTarget): Promise<boolean> {
    const applied = this.options.lifecycle.configuration();
    if (!applied || runtimeDelta(applied, target).restartRequired) return false;
    const core = await this.options.supervisor.status();
    return core.running && core.healthy === true;
  }

  async stop(): Promise<void> {
    this.cancelPreparation();
    await this.options.commit(() => this.options.lifecycle.stop());
  }
}
