import type { SashStateStore } from "./app-state.js";
import type { SettingsPatch } from "./contracts.js";
import type { ProfileCommitBoundary } from "./profile-service.js";
import type { RuntimeLifecycle } from "./runtime-lifecycle.js";
import { type SashSettings, validateSettingsCandidate } from "./settings.js";
import type { CoreSupervisor } from "./supervisor.js";

export class SettingsInputError extends Error {}
export class CoreUnhealthyError extends Error {}
export { StateConflictError as SettingsConflictError } from "./app-state.js";

export interface SettingsApplyResult {
  settings: SashSettings;
  restartRequired: boolean;
}
export interface SettingsServiceOptions {
  state: SashStateStore;
  commit: ProfileCommitBoundary;
  lifecycle: RuntimeLifecycle;
  supervisor: CoreSupervisor;
}

/** Saves preferences. Applying Core configuration is an explicit, separate operation. */
export class SettingsService {
  constructor(private readonly options: SettingsServiceOptions) {}

  async apply(patch: SettingsPatch): Promise<SettingsApplyResult> {
    return this.options.commit("save settings", async () => {
      const state = this.options.state.snapshot();
      let settings: SashSettings;
      try {
        settings = validateSettingsCandidate({ ...state.settings, ...patch });
      } catch (error) {
        throw new SettingsInputError(error instanceof Error ? error.message : String(error));
      }
      if (patch.systemProxy === true) {
        const core = await this.options.supervisor.status();
        if (!core.running || !core.healthy)
          throw new CoreUnhealthyError("Cannot enable system proxy: Core is not healthy");
      }
      this.options.state.assertCurrent(state.revision);
      const changed =
        settings.mixedPort !== state.settings.mixedPort ||
        settings.allowLan !== state.settings.allowLan ||
        settings.systemProxy !== state.settings.systemProxy;
      const saved = changed ? this.options.state.commit({ ...state, settings }) : state;
      if (patch.systemProxy !== undefined) {
        // Desired state stays visible on failure; the proxy journal retains the recovery data.
        await this.options.lifecycle.reconcileSystemProxy();
      }
      const running = this.options.lifecycle.settings();
      return {
        settings: saved.settings,
        restartRequired:
          saved.settings.mixedPort !== running.mixedPort ||
          saved.settings.allowLan !== running.allowLan,
      };
    });
  }
}
