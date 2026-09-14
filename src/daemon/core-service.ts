import fs from "node:fs";
import path from "node:path";
import { type SashStateStore, StateConflictError } from "../app-state.js";
import type { CoreStartResult } from "../contracts.js";
import {
  assertCoreInstallationConsistent,
  coreInstalled,
  currentCoreVersion,
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
import { formatProxyFallbackWarning } from "../http.js";
import { GEOX_MIRROR_SETS, type GeneratedConfig, withGeodataMirrors } from "../mihomo-config.js";
import type { SashLayout } from "../paths.js";
import { renderActiveConfig } from "../profile-service.js";
import { getActiveProfile } from "../profiles.js";
import type { RuntimeConfiguration, RuntimeLifecycle } from "../runtime-lifecycle.js";
import type { CoreSupervisor } from "../supervisor.js";

export interface CoreControlServiceOptions {
  layout: SashLayout;
  state: SashStateStore;
  supervisor: CoreSupervisor;
  lifecycle: RuntimeLifecycle;
  /** The daemon mutation queue: state and lifecycle changes run through it. */
  commit: <T>(action: () => T | Promise<T>) => Promise<T>;
  assertMutable: () => void;
  /** Fires whenever the observable update progress changes. */
  onProgress: () => void;
  validateConfigFn?: (
    generated: GeneratedConfig,
    executable: string,
    signal: AbortSignal,
  ) => Promise<void> | void;
  stageCoreFn?: typeof stageCore;
  seedGeodataFn?: (file: string, options: { signal: AbortSignal }) => Promise<GeodataSeedResult>;
}

/**
 * Orchestrates Core preparation, validation, updates and lifecycle changes.
 * Downloads prepare outside the mutation queue; publication re-checks that
 * saved state and the runtime still match the operation's starting point.
 */
export class CoreControlService {
  private downloading = false;
  private progressValue: CoreUpdateProgress | null = null;
  private preparation = new AbortController();

  constructor(private readonly options: CoreControlServiceOptions) {}

  get progress(): CoreUpdateProgress | null {
    return this.progressValue ? { ...this.progressValue } : null;
  }

  /** True for the whole update operation, from staging through installation. */
  get isUpdating(): boolean {
    return this.downloading;
  }

  cancelPreparation(): void {
    this.preparation.abort(new StateConflictError("Core operation cancelled"));
    this.preparation = new AbortController();
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
   * Validate a configuration, and if the Core failed only because it could not
   * download its geodata databases, retry through each mirror set. The Core
   * fetches geodata from github.com by default and cannot use the proxy it has
   * not started yet, which would otherwise deadlock a fresh installation on a
   * network that cannot reach github.com directly. Mirror attempts get a
   * longer budget: downloading tens of megabytes takes more than the plain
   * configuration test's timeout.
   */
  private async validateConfiguration(
    configuration: RuntimeConfiguration,
    executable: string,
    signal: AbortSignal,
  ): Promise<RuntimeConfiguration> {
    const seedGeodata =
      this.options.seedGeodataFn ??
      ((file: string, options: { signal: AbortSignal }) =>
        seedGeodataFile(file, this.options.layout, options));
    try {
      await this.validate(configuration.generated, executable, signal);
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
          const result = await seedGeodata(file, { signal });
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

  private savedConfiguration(): RuntimeConfiguration {
    const snapshot = this.options.state.snapshot();
    const profile = getActiveProfile(snapshot.profiles);
    return {
      generated: renderActiveConfig(snapshot, this.options.layout),
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

  async update(version?: string, startAfterInstall = false): Promise<CoreUpdateResult> {
    const { layout, state, supervisor, lifecycle } = this.options;
    this.options.assertMutable();
    if (this.downloading) throw new StateConflictError("A Core download is already in progress");
    this.requireRecoveredInstall();
    const { signal } = this.preparation;
    this.downloading = true;
    const progress: CoreUpdateProgress = {
      stage: "checking",
      startedAt: new Date().toISOString(),
      target: version ?? null,
      downloading: false,
      downloaded: 0,
      total: null,
    };
    this.progressValue = progress;
    this.options.onProgress();
    const setStage = (stage: CoreUpdateStage, target?: string): void => {
      progress.stage = stage;
      progress.downloading = stage === "downloading";
      if (target) progress.target = target;
      this.options.onProgress();
    };
    let staged: StagedCore | undefined;
    try {
      signal.throwIfAborted();
      this.requireRecoveredInstall();
      const revision = state.snapshot().revision;
      const epoch = lifecycle.revision;
      const configuration = supervisor.isRunning()
        ? lifecycle.configuration()
        : this.savedConfiguration();
      if (!configuration) throw new Error("Running Core configuration is unknown");
      setStage("resolving");
      staged = await (this.options.stageCoreFn ?? stageCore)({
        layout,
        tag: version,
        signal,
        onStage: setStage,
        onProgress: (downloaded, total) => {
          progress.downloaded = downloaded;
          progress.total = total ?? null;
          this.options.onProgress();
        },
        onProxyFallback: (info) => {
          const warning = formatProxyFallbackWarning(info);
          progress.note = warning;
          this.options.onProgress();
          console.warn(`[sashd] ${warning}`);
        },
      });
      signal.throwIfAborted();
      setStage("validating", staged.version);
      if (staged.source === "pinned") {
        const note = `pinned offline Core ${staged.version} — run sash update when GitHub is reachable`;
        progress.note = note;
        this.options.onProgress();
        console.warn(`[sashd] ${note}`);
      }
      const validated = await this.validateConfiguration(configuration, staged.exe, signal);
      const candidate = staged;
      setStage("waiting");
      return await this.options.commit(async () => {
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
      this.downloading = false;
      this.progressValue = null;
      this.options.onProgress();
      if (staged) {
        fs.rmSync(staged.exe, { force: true });
        try {
          fs.rmdirSync(path.dirname(staged.exe));
        } catch {
          /* Only remove an empty staging directory. */
        }
      }
    }
  }

  /** Apply the saved configuration, installing the Core first when missing. */
  async apply(onlyIfStopped = false): Promise<CoreStartResult> {
    const { layout, supervisor, lifecycle } = this.options;
    this.options.assertMutable();
    const { signal } = this.preparation;
    this.requireRecoveredInstall();
    signal.throwIfAborted();
    const installedNow = !coreInstalled(layout);
    if (installedNow) await this.update(undefined, true);
    return this.options.commit(async () => {
      signal.throwIfAborted();
      this.requireRecoveredInstall();
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
      const configuration = this.savedConfiguration();
      const validated = await this.validateConfiguration(configuration, layout.coreExe, signal);
      signal.throwIfAborted();
      return lifecycle.apply(validated);
    });
  }

  /** Start the Core unless it is already running. */
  start(): Promise<CoreStartResult> {
    return this.apply(true);
  }

  async stop(): Promise<void> {
    this.cancelPreparation();
    await this.options.commit(() => this.options.lifecycle.stop());
  }
}
