import { commitManagedStateTransaction } from "./managed-state-transaction.js";
import type { SashLayout } from "./paths.js";
import {
  type PreparedActivePublication,
  ProfileConflictError,
  type ProfileService,
} from "./profile-service.js";
import type { RuntimeLifecycle } from "./runtime-lifecycle.js";
import {
  applyManagedKey,
  requiresCoreRestart,
  type SashSettings,
  type SettableKey,
  sameSettings,
} from "./settings.js";
import type { CoreSupervisor } from "./supervisor.js";
import { tunPrivilegeGuidance } from "./tun-guidance.js";

export class SettingsInputError extends Error {}

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

/**
 * Applies a managed setting as an immutable candidate. Rendering, remote
 * profile fetches and Core validation occur before `commit`; that boundary
 * only rechecks snapshots, publishes durable state, and transitions runtime.
 */
export class SettingsService {
  private readonly options: SettingsServiceOptions;

  constructor(options: SettingsServiceOptions) {
    this.options = options;
  }

  async update(key: string, value: string | undefined): Promise<SashSettings> {
    const previous = { ...this.options.getCommitted() };
    let candidate: SashSettings;
    try {
      candidate = applyManagedKey(previous, key, value);
    } catch (err) {
      throw new SettingsInputError((err as Error).message);
    }

    if (key === "system-proxy") return this.updateSystemProxy(previous, candidate);
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
                return this.commitCoreSettings(previous, candidate, key, publication);
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

  private async updateSystemProxy(
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
      throw new SettingsInputError("Cannot enable system proxy: core is not healthy");
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
    key: string,
    publication: PreparedActivePublication,
  ): Promise<SashSettings> {
    const wasRunning = this.options.supervisor?.isRunning() ?? false;
    const restart = wasRunning && requiresCoreRestart(key);
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
            if (!restart) return;
            const result = await this.requireLifecycle().restart();
            if (key === "tun" && candidate.tun && result.tunActive !== true) {
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

  /**
   * Apply a whole edited settings file (from the WebUI JSON editor) by
   * diffing every managed key against the committed settings and routing each
   * change through the per-key update path. Restart-requiring keys run before
   * system-proxy so the proxy is reconciled against the final core state.
   */
  async applyFileSettings(next: SashSettings): Promise<void> {
    const current = this.options.getCommitted();
    const changes: Array<[SettableKey, string]> = [];
    if (next.mixedPort !== current.mixedPort) changes.push(["mixed-port", String(next.mixedPort)]);
    if (next.controller !== current.controller) changes.push(["controller", next.controller]);
    if (next.secret !== current.secret) changes.push(["secret", next.secret]);
    if (next.tun !== current.tun) changes.push(["tun", next.tun ? "on" : "off"]);
    if (next.allowLan !== current.allowLan)
      changes.push(["allow-lan", next.allowLan ? "on" : "off"]);
    if (next.systemProxy !== current.systemProxy)
      changes.push(["system-proxy", next.systemProxy ? "on" : "off"]);
    for (const [key, value] of changes) await this.update(key, value);
  }
}
