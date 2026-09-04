import type { SettingsPatch } from "./contracts.js";
import { commitManagedStateTransaction } from "./managed-state-transaction.js";
import type { SashLayout } from "./paths.js";
import {
  type PreparedActivePublication,
  ProfileConflictError,
  type ProfileService,
} from "./profile-service.js";
import type { RuntimeLifecycle } from "./runtime-lifecycle.js";
import { type SashSettings, sameSettings, validateSettingsCandidate } from "./settings.js";
import type { CoreSupervisor } from "./supervisor.js";
import { tunPrivilegeGuidance } from "./tun-guidance.js";

export class SettingsInputError extends Error {}

/** Enabling the system proxy requires a running, healthy Core. */
export class CoreUnhealthyError extends Error {}

/** Internal patch superset: the settings file editor may also diff Core-facing keys. */
export interface ManagedSettingsPatch extends SettingsPatch {
  controller?: string;
  secret?: string;
}

export interface SettingsApplyResult {
  settings: SashSettings;
  /** The daemon listener cannot rebind online; a daemon restart is pending. */
  restartRequired: boolean;
}

export type SettingsCommitBoundary = <T>(
  purpose: string,
  action: () => T | Promise<T>,
) => Promise<T>;

export interface SettingsServiceOptions {
  layout: SashLayout;
  getCommitted: () => SashSettings;
  setCommitted: (settings: SashSettings) => void;
  setRuntime: (settings: SashSettings) => void;
  profiles: ProfileService;
  supervisor?: CoreSupervisor;
  lifecycle?: RuntimeLifecycle;
  /** Offline proxy-off release; online uses RuntimeLifecycle instead. */
  releaseSystemProxy?: () => Promise<void>;
  commit: SettingsCommitBoundary;
}

const CORE_SETTING_KEYS = ["mixedPort", "controller", "secret", "tun", "allowLan"] as const;

/**
 * Applies a partial settings patch as immutable candidates. Rendering, remote
 * profile fetches and Core validation occur before `commit`; that boundary
 * only rechecks snapshots, publishes durable state, and transitions runtime.
 *
 * One apply performs at most two commits: Core/daemon-affecting keys publish
 * settings plus regenerated config in the first transaction, then a system
 * proxy toggle follows in its own transaction so the OS proxy is reconciled
 * against the final Core state.
 */
export class SettingsService {
  private readonly options: SettingsServiceOptions;

  constructor(options: SettingsServiceOptions) {
    this.options = options;
  }

  async apply(patch: ManagedSettingsPatch): Promise<SettingsApplyResult> {
    const previous = { ...this.options.getCommitted() };
    let candidate: SashSettings;
    try {
      candidate = validateSettingsCandidate(mergePatch(previous, patch));
    } catch (err) {
      throw new SettingsInputError((err as Error).message);
    }

    const restartRequired = candidate.daemonPort !== previous.daemonPort;
    const proxyChanged = candidate.systemProxy !== previous.systemProxy;
    const coreChanged = CORE_SETTING_KEYS.some((key) => candidate[key] !== previous[key]);
    const daemonChanged = restartRequired || candidate.daemonSecret !== previous.daemonSecret;

    let committed = previous;
    if (coreChanged || daemonChanged) {
      // The proxy toggle is staged separately; keep its desired state unchanged
      // in this transaction so a failed proxy enable never persists desired=true.
      const staged: SashSettings = { ...candidate, systemProxy: previous.systemProxy };
      committed = coreChanged
        ? await this.commitCoreChange(previous, staged, {
            verifyTun: candidate.tun && !previous.tun,
          })
        : await this.commitSettingsOnly(previous, staged);
    }
    if (proxyChanged) {
      committed = await this.commitSystemProxy(committed, candidate);
    }
    return { settings: committed, restartRequired };
  }

  /**
   * Apply a whole edited settings file (from the WebUI JSON editor) by
   * diffing every managed key against the committed settings and applying the
   * resulting patch in one call.
   */
  async applyFileSettings(next: SashSettings): Promise<SettingsApplyResult> {
    const current = this.options.getCommitted();
    const patch: ManagedSettingsPatch = {};
    if (next.mixedPort !== current.mixedPort) patch.mixedPort = next.mixedPort;
    if (next.controller !== current.controller) patch.controller = next.controller;
    if (next.secret !== current.secret) patch.secret = next.secret;
    if (next.tun !== current.tun) patch.tun = next.tun;
    if (next.allowLan !== current.allowLan) patch.allowLan = next.allowLan;
    if (next.systemProxy !== current.systemProxy) patch.systemProxy = next.systemProxy;
    if (next.daemonPort !== current.daemonPort) patch.daemonPort = next.daemonPort;
    if (next.daemonSecret !== current.daemonSecret) patch.daemonSecret = next.daemonSecret;
    return this.apply(patch);
  }

  /** Settings-only transaction for daemon-level keys (no config republication). */
  private async commitSettingsOnly(
    previous: SashSettings,
    candidate: SashSettings,
  ): Promise<SashSettings> {
    return this.options.commit("update daemon settings", async () => {
      this.assertCurrent(previous);
      this.options.setRuntime(candidate);
      try {
        await commitManagedStateTransaction(
          this.options.layout,
          { settings: candidate },
          undefined,
        );
      } catch (err) {
        this.options.setRuntime(previous);
        throw err;
      }
      this.options.setCommitted(candidate);
      return candidate;
    });
  }

  private async commitCoreChange(
    previous: SashSettings,
    candidate: SashSettings,
    opts: { verifyTun: boolean },
  ): Promise<SashSettings> {
    for (let attempt = 0; ; attempt += 1) {
      const prepared = await this.options.profiles.prepareActiveConfig(candidate, previous);
      let retryableProfileConflict: ProfileConflictError | undefined;
      let callbackEntered = false;
      try {
        return await this.options.commit("update settings", async () => {
          this.assertCurrent(previous);
          try {
            return await this.options.profiles.withPreparedActivePublication(
              prepared,
              async (publication) => {
                callbackEntered = true;
                return this.commitCoreSettings(previous, candidate, opts, publication);
              },
            );
          } catch (err) {
            if (err instanceof ProfileConflictError && !callbackEntered) {
              retryableProfileConflict = err;
            }
            throw err;
          }
        });
      } catch (err) {
        if (err !== retryableProfileConflict || attempt >= 1) throw err;
      }
    }
  }

  private async commitSystemProxy(
    previous: SashSettings,
    candidate: SashSettings,
  ): Promise<SashSettings> {
    if (!candidate.systemProxy) {
      // Off is intentionally durable before release. A failed release retains
      // desired=false and the ownership journal so a later retry can recover.
      return this.options.commit("disable system proxy", async () => {
        this.assertCurrent(previous);
        this.options.setRuntime(candidate);
        try {
          await commitManagedStateTransaction(
            this.options.layout,
            { settings: candidate },
            undefined,
          );
        } catch (err) {
          this.options.setRuntime(previous);
          throw err;
        }
        this.options.setCommitted(candidate);
        if (this.options.lifecycle) await this.options.lifecycle.reconcileSystemProxy();
        else await this.options.releaseSystemProxy?.();
        return candidate;
      });
    }

    const core = await this.options.supervisor?.status();
    if (!core?.running || !core.healthy) {
      throw new CoreUnhealthyError("Cannot enable system proxy: core is not healthy");
    }
    return this.options.commit("enable system proxy", async () => {
      this.assertCurrent(previous);
      this.options.setRuntime(candidate);
      try {
        await commitManagedStateTransaction(
          this.options.layout,
          {
            settings: candidate,
            applyRuntime: () => this.requireLifecycle().reconcileSystemProxy(),
          },
          undefined,
        );
        this.options.setCommitted(candidate);
        return candidate;
      } catch (err) {
        this.options.setRuntime(previous);
        try {
          await this.requireLifecycle().reconcileSystemProxy();
        } catch (rollback) {
          throw new Error(
            `${(err as Error).message}; system proxy rollback failed: ${(rollback as Error).message}`,
          );
        }
        throw err;
      }
    });
  }

  private async commitCoreSettings(
    previous: SashSettings,
    candidate: SashSettings,
    opts: { verifyTun: boolean },
    publication: PreparedActivePublication,
  ): Promise<SashSettings> {
    const wasRunning = this.options.supervisor?.isRunning() ?? false;
    this.options.setRuntime(candidate);
    try {
      await commitManagedStateTransaction(
        this.options.layout,
        {
          ...(publication.index ? { index: publication.index } : {}),
          ...(publication.profile
            ? {
                profile: {
                  id: publication.profile.id,
                  yamlText: publication.profile.yamlText,
                },
              }
            : {}),
          config: publication.config,
          settings: candidate,
          reloadRuntime: false,
          applyRuntime: async () => {
            if (!wasRunning) return;
            const result = await this.requireLifecycle().restart();
            if (opts.verifyTun && result.tunActive !== true) {
              throw new Error(
                result.tunActive === false
                  ? `TUN did not become active. ${tunPrivilegeGuidance("activation-rolled-back", { root: this.options.layout.root })}`
                  : `TUN activation could not be verified through the Core controller. ${tunPrivilegeGuidance("activation-rolled-back", { root: this.options.layout.root })}`,
              );
            }
          },
        },
        undefined,
      );
      this.options.setCommitted(candidate);
      return candidate;
    } catch (err) {
      this.options.setRuntime(previous);
      const rollbackErrors: string[] = [];
      try {
        // The rollback config was rendered and validated before entering this
        // boundary, including when no prior config file existed.
        await this.options.profiles.commitPreparedActiveReload(publication.rollback, {
          reloadRuntime: false,
          boundary: "already-held",
        });
      } catch (rollback) {
        rollbackErrors.push(`config rollback failed: ${(rollback as Error).message}`);
      }
      if (wasRunning) {
        try {
          if (this.options.supervisor?.isRunning()) await this.requireLifecycle().restart();
          else await this.requireLifecycle().start();
        } catch (rollback) {
          rollbackErrors.push(`runtime rollback failed: ${(rollback as Error).message}`);
        }
      }
      if (rollbackErrors.length)
        throw new Error(`${(err as Error).message}; ${rollbackErrors.join("; ")}`);
      throw err;
    }
  }

  private requireLifecycle(): RuntimeLifecycle {
    if (!this.options.lifecycle)
      throw new Error("No runtime lifecycle is available for this settings mutation");
    return this.options.lifecycle;
  }

  private assertCurrent(previous: SashSettings): void {
    if (!sameSettings(this.options.getCommitted(), previous)) {
      throw new Error("Settings changed while preparing configuration");
    }
  }
}

function mergePatch(previous: SashSettings, patch: ManagedSettingsPatch): SashSettings {
  const candidate = { ...previous };
  if (patch.mixedPort !== undefined) candidate.mixedPort = patch.mixedPort;
  if (patch.controller !== undefined) candidate.controller = patch.controller;
  if (patch.secret !== undefined) candidate.secret = patch.secret;
  if (patch.tun !== undefined) candidate.tun = patch.tun;
  if (patch.allowLan !== undefined) candidate.allowLan = patch.allowLan;
  if (patch.systemProxy !== undefined) candidate.systemProxy = patch.systemProxy;
  if (patch.daemonPort !== undefined) candidate.daemonPort = patch.daemonPort;
  if (patch.daemonSecret !== undefined) candidate.daemonSecret = patch.daemonSecret;
  return candidate;
}
