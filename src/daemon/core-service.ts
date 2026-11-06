import fs from "node:fs";
import { type SashStateStore, StateConflictError } from "../app-state.js";
import type { CoreStartResult } from "../contracts.js";
import {
  assertCoreInstallationConsistent,
  coreInstalled,
  currentCoreVersion,
  resolveCoreRelease,
  type StagedCore,
  stageCore,
} from "../core.js";
import {
  CONFIG_TEST_GEODATA_TIMEOUT_MS,
  geodataFileForFailure,
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
import { type GeodataSeedResult, seedGeodataFile } from "../geodata-seed.js";
import { type DownloadTransport, envProxyUri, formatProxyFallbackWarning } from "../http.js";
import { GEOX_MIRROR_SETS, type GeneratedConfig } from "../mihomo-config.js";
import type { SashLayout } from "../paths.js";
import { renderActiveConfig } from "../profile-service.js";
import { renderGeodataMirrorsOffThread } from "../profile-work.js";
import { getActiveProfile } from "../profiles.js";
import type {
  RuntimeConfiguration,
  RuntimeLifecycle,
  RuntimeTarget,
} from "../runtime-lifecycle.js";
import { runtimeDelta } from "../runtime-lifecycle.js";
import type { CoreSupervisor } from "../supervisor.js";

export interface CoreControlServiceOptions {
  layout: SashLayout;
  state: SashStateStore;
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
}

const PROGRESS_NOTIFY_INTERVAL_MS = 250;

/**
 * Preparation stays outside the mutation queue; publication compares the
 * configuration it actually uses and the captured runtime epoch.
 */
export class CoreControlService {
  private validationTail: Promise<void> = Promise.resolve();
  private preparation = new AbortController();
  private operation: CoreUpdateProgress | null = null;
  private lastProgressNotify = 0;

  constructor(private readonly options: CoreControlServiceOptions) {}

  get progress(): CoreUpdateProgress | null {
    return this.operation ? { ...this.operation } : null;
  }

  get isUpdating(): boolean {
    return this.operation !== null;
  }

  get pendingApply(): boolean {
    return runtimeDelta(this.options.lifecycle.configuration(), this.savedTarget()).pending;
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
        : validateCoreConfig(executable, generated.yaml, this.options.layout, {
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
      if (!isGeodataDownloadFailure(error)) throw error;
      const seen = new Set([configuration.generated.yaml]);
      let lastError = error;
      for (const mirrors of GEOX_MIRROR_SETS) {
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
            CONFIG_TEST_GEODATA_TIMEOUT_MS,
          );
          return retried;
        } catch (mirrorError) {
          if (!isGeodataDownloadFailure(mirrorError)) throw mirrorError;
          lastError = mirrorError;
        }
      }
      // Every mirror failed: fetch the missing databases through the verified
      // pipeline (release-API digest, or the packaged bootstrap manifest when
      // the API is unreachable), then revalidate the original configuration —
      // the Core skips downloads for files already in the data folder.
      const seeded = new Set<string>();
      for (;;) {
        const file = geodataFileForFailure(lastError);
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
          if (!isGeodataDownloadFailure(retryError)) throw retryError;
          lastError = retryError;
        }
      }
      throw lastError;
    }
  }

  private async savedConfiguration(
    snapshot = this.options.state.snapshot(),
  ): Promise<RuntimeConfiguration> {
    const profile = getActiveProfile(snapshot.profiles);
    return {
      generated: await renderActiveConfig(snapshot, this.options.layout),
      settings: snapshot.settings,
      profile: profile
        ? { id: profile.id, revision: profile.revision, name: profile.name, url: profile.url }
        : null,
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

  private configurationPlan() {
    return { snapshot: this.options.state.snapshot(), epoch: this.options.lifecycle.revision };
  }

  private assertCurrentConfiguration(configuration: RuntimeConfiguration): void {
    if (runtimeDelta(configuration, this.savedTarget()).pending)
      throw new StateConflictError("Saved configuration changed during preparation; retry Apply");
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
    // Chosen once: the transport must not change between metadata, archive and
    // geodata fetches inside one operation.
    const transport = this.downloadTransport();
    const proxyUri = transport?.uri;
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
        ...(proxyUri !== undefined ? { proxyUri } : {}),
        onProxyFallback: (info) => {
          const warning = formatProxyFallbackWarning(info);
          progress.note = warning;
          this.publishProgress(true);
          console.warn(`[sashd] ${warning}`);
        },
      });
      signal.throwIfAborted();
      // The release is already installed: downloading it again would replace a
      // healthy binary with the same bytes and pause the proxy for nothing.
      if (release.tag === currentCoreVersion(layout)) {
        progress.target = release.tag;
        return { version: release.tag, alreadyCurrent: true };
      }
      staged = await (this.options.stageCoreFn ?? stageCore)({
        layout,
        release,
        signal,
        ...(proxyUri !== undefined ? { proxyUri } : {}),
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
        proxyUri,
      );
      const candidate = staged;
      setStage("waiting");
      return await this.options.commit(async () => {
        signal.throwIfAborted();
        // A running update preserves the applied configuration, not pending saved edits.
        if (!wasRunning) this.assertCurrentConfiguration(validated);
        if (lifecycle.revision !== epoch)
          throw new StateConflictError("Core changed during download; retry the update");
        setStage("installing");
        return lifecycle.update(candidate, validated, startAfterInstall);
      });
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      // Only the operation still owning the observable state may clear it; a
      // cancelled predecessor unwinds after its successor already started.
      if (this.operation === progress) {
        this.operation = null;
        this.options.onProgress();
      }
      if (staged) fs.rmSync(staged.dir, { recursive: true, force: true });
    }
  }

  async apply(): Promise<CoreStartResult> {
    this.options.assertMutable();
    return this.applySavedConfiguration("apply");
  }

  async start(): Promise<CoreStartResult> {
    this.options.assertMutable();
    return this.applySavedConfiguration("start");
  }

  async reconcileSaved(): Promise<boolean> {
    this.options.assertMutable();
    if (this.isUpdating || this.preparation.signal.aborted) return false;
    try {
      return Boolean(await this.applySavedConfiguration("reconcile"));
    } catch (error) {
      // Saving already succeeded; a rejected configuration stays pending.
      console.warn(`[sashd] saved configuration was not applied: ${errorMessage(error)}`);
      return false;
    }
  }

  private applySavedConfiguration(intent: "start" | "apply"): Promise<CoreStartResult>;
  private applySavedConfiguration(intent: "reconcile"): Promise<CoreStartResult | undefined>;
  private async applySavedConfiguration(
    intent: "start" | "apply" | "reconcile",
  ): Promise<CoreStartResult | undefined> {
    const { layout, supervisor, lifecycle } = this.options;
    const { signal } = this.preparation;
    if (intent !== "reconcile") {
      this.requireRecoveredInstall();
      signal.throwIfAborted();
      if (!coreInstalled(layout)) {
        await this.update(undefined, true);
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
    }

    // Start/Apply capture after earlier queued lifecycle operations. A saved
    // profile reconciliation already follows its publication and needs no read-only queue turn.
    const plan =
      intent === "reconcile"
        ? this.configurationPlan()
        : await this.options.commit(async () => {
            signal.throwIfAborted();
            this.requireRecoveredInstall();
            if (intent === "start" && supervisor.isRunning()) return lifecycle.start();
            return this.configurationPlan();
          });
    if (!("snapshot" in plan)) return plan;

    if (intent === "reconcile") {
      const target = this.savedTarget(plan.snapshot);
      if (
        !runtimeDelta(lifecycle.configuration(), target).pending ||
        !(await this.canReload(target))
      )
        return undefined;
    }

    // All intents share rendering and preflight outside the state mutation queue.
    const configuration = await this.savedConfiguration(plan.snapshot);
    const validated = await this.validateConfiguration(
      configuration,
      layout.coreExe,
      signal,
      intent === "reconcile" ? undefined : this.downloadTransport()?.uri,
    );
    return this.options.commit(async () => {
      signal.throwIfAborted();
      if (intent !== "reconcile") this.requireRecoveredInstall();
      if (intent === "start" && supervisor.isRunning()) return lifecycle.start();
      this.assertCurrentConfiguration(validated);
      if (lifecycle.revision !== plan.epoch) {
        if (intent === "reconcile") return undefined;
        throw new StateConflictError("Core changed during preparation; retry Apply");
      }
      if (await this.canReload(validated)) return lifecycle.reload(validated, signal);
      if (intent === "reconcile") return undefined;
      return lifecycle.apply(validated);
    });
  }

  /** Sash uses non-forced reloads: listener changes take the restart path. */
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
