import { commitManagedStateTransaction } from "./managed-state-transaction.js";
import type { SashLayout } from "./paths.js";
import {
  type PreparedActiveConfig,
  ProfileConflictError,
  type ProfileService,
} from "./profile-service.js";
import type { RuntimeLifecycle } from "./runtime-lifecycle.js";
import { applyManagedKey, requiresCoreRestart, type SashSettings } from "./settings.js";
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

function sameSettings(a: SashSettings, b: SashSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
      const prepared = await this.options.profiles.prepareActiveConfig(candidate);
      try {
        return await this.options.commit("update settings", () =>
          this.commitCoreSettings(previous, candidate, key, prepared),
        );
      } catch (err) {
        if (!(err instanceof ProfileConflictError) || attempt >= 1) throw err;
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
    prepared: PreparedActiveConfig,
  ): Promise<SashSettings> {
    this.assertCurrent(previous);
    this.options.profiles.assertPreparedActiveCurrent(prepared);
    const publication = this.options.profiles.preparedActivePublication(prepared);
    const wasRunning = this.options.supervisor?.isRunning() ?? false;
    const restart = wasRunning && requiresCoreRestart(key);
    this.options.setRuntime(candidate);
    try {
      await commitManagedStateTransaction(
        this.options.layout,
        {
          ...publication,
          config: prepared.generated,
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
      this.options.profiles.notifyPreparedActivePublished(prepared);
      this.options.setCommitted(candidate);
      return candidate;
    } catch (err) {
      this.options.setRuntime(previous);
      const rollbackErrors: string[] = [];
      try {
        // Rebuild the old config even when no prior config file existed; the
        // old Core cannot be restarted safely without a configuration.
        await this.options.profiles.reloadActive(false, false);
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
