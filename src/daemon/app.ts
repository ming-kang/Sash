import crypto from "node:crypto";
import { MihomoApi } from "../api.js";
import type { CoreStartResult } from "../contracts.js";
import { currentCoreVersion } from "../core.js";
import { validateCoreConfigText } from "../core-config-validation.js";
import { type CoreRuntime, requireServiceForTun } from "../core-runtime.js";
import { pendingCoreUpdateVersion, readCoreUpdateTransaction } from "../core-update.js";
import {
  completeCoordinatedCoreUpdateAfterStart,
  rollbackCoordinatedCoreUpdate,
} from "../core-update-coordination.js";
import type { GeneratedConfig, SubscriptionFetch } from "../mihomo-config.js";
import type { SashLayout } from "../paths.js";
import {
  type PreparedActiveReload,
  ProfileConflictError,
  ProfileService,
} from "../profile-service.js";
import { RuntimeLifecycle } from "../runtime-lifecycle.js";
import { type SashSettings, saveSettings } from "../settings.js";
import { SettingsService, TunActivationError } from "../settings-service.js";
import { StateMutationQueue } from "../state-lock.js";
import { CoreSupervisor } from "../supervisor.js";
import { type SystemProxyController, SystemProxyManager } from "../system-proxy-manager.js";
import { tunPrivilegeGuidance } from "../tun-guidance.js";
import { type DaemonContext, DaemonGate } from "./context.js";
import type { DaemonScheduler } from "./scheduler.js";
import { WebAuthManager } from "./web-auth.js";

export interface DaemonDeps {
  layout: SashLayout;
  settings: SashSettings;
  supervisor?: CoreRuntime;
  systemProxy?: SystemProxyController;
  runtimeFactory?: (settings: () => SashSettings) => CoreRuntime;
  token?: string;
  fetchProfileFn?: (url: string) => Promise<SubscriptionFetch>;
  validateConfigFn?: (generated: GeneratedConfig) => Promise<void> | void;
  onShutdown?: () => void;
  scheduler?: DaemonScheduler;
}

export interface DaemonApp {
  context: DaemonContext;
  supervisor: CoreRuntime;
  lifecycle: RuntimeLifecycle;
  token: string;
}

/** Assemble the daemon's services and domain actions around one state queue. */
export function buildDaemonContext(deps: DaemonDeps): DaemonApp {
  const layout = deps.layout;
  let committedSettings = saveSettings({ ...deps.settings }, layout);
  let runtimeSettings = committedSettings;
  const token = deps.token ?? crypto.randomBytes(24).toString("hex");
  const startedAt = new Date().toISOString();
  const systemProxy = deps.systemProxy ?? new SystemProxyManager({ layout });
  const mutations = new StateMutationQueue(layout.mutationLockFile);
  let profileRevision = 0;

  let lifecycle: RuntimeLifecycle | undefined;
  const supervisor: CoreRuntime =
    deps.supervisor ??
    deps.runtimeFactory?.(() => runtimeSettings) ??
    new CoreSupervisor({
      layout,
      settings: () => runtimeSettings,
      expectedVersion: () =>
        pendingCoreUpdateVersion(layout) || currentCoreVersion(layout) || undefined,
      onExit: async () => {
        try {
          await lifecycle?.handleUnexpectedCoreExit();
        } catch (err) {
          console.error(
            `[sashd] failed to restore system proxy after Core exit: ${(err as Error).message}`,
          );
        }
      },
    });
  lifecycle = new RuntimeLifecycle({
    supervisor,
    systemProxy,
    settings: () => runtimeSettings,
    ...(supervisor.backend === "service"
      ? {}
      : {
          coreUpdate: {
            pending: () => readCoreUpdateTransaction(layout) !== undefined,
            completeAfterStart: () => {
              completeCoordinatedCoreUpdateAfterStart(layout);
            },
            rollbackAfterStartFailure: () => rollbackCoordinatedCoreUpdate(layout),
          },
        }),
  });

  supervisor.onAvailabilityLoss?.((snapshot) => lifecycle.handleAvailabilityLoss(snapshot));
  const coreControllerEndpoint = () => supervisor.controllerEndpoint?.() ?? runtimeSettings;

  const gate = new DaemonGate(mutations, async () => {
    const coreWasRunning = supervisor.isRunning();
    await lifecycle.close();
    return { coreWasRunning };
  });
  const mutate = <T>(purpose: string, action: () => T | Promise<T>): Promise<T> =>
    gate.mutate(purpose, action);

  const profiles = new ProfileService({
    layout,
    settings: () => committedSettings,
    ...(deps.fetchProfileFn ? { fetchProfile: deps.fetchProfileFn } : {}),
    validateConfig:
      deps.validateConfigFn ??
      ((generated) =>
        supervisor.validateConfig
          ? supervisor.validateConfig(generated.yaml)
          : validateCoreConfigText(generated.yaml, layout)),
    reloadConfig: async (configPath) => {
      if (!supervisor.isRunning()) return;
      const endpoint = coreControllerEndpoint();
      const api = new MihomoApi(endpoint.controller, endpoint.secret);
      if (supervisor.reloadConfig) await supervisor.reloadConfig(configPath);
      else await api.reloadConfig(configPath);
      if (runtimeSettings.tun) {
        const active = await api.getTunActive().catch(() => undefined);
        if (active !== true) {
          const reason = active === false ? "inactive" : "unverified";
          throw new TunActivationError(
            reason,
            `TUN is ${reason} after configuration reload. ${supervisor.backend === "service" ? "Inspect Sash Service diagnostics before retrying." : tunPrivilegeGuidance("runtime-inactive", { root: layout.root, observation: reason })}`,
          );
        }
      }
    },
    commit: mutate,
    onChange: () => {
      profileRevision += 1;
    },
  });

  const settingsService = new SettingsService({
    layout,
    getCommitted: () => committedSettings,
    setCommitted: (next) => {
      committedSettings = { ...next };
    },
    setRuntime: (next) => {
      runtimeSettings = { ...next };
    },
    profiles,
    supervisor,
    lifecycle,
    commit: mutate,
  });

  const commitPreparedReload = (
    prepared: PreparedActiveReload,
    reloadRuntime: boolean,
  ): Promise<GeneratedConfig> =>
    profiles.commitPreparedActiveReload(prepared, {
      reloadRuntime,
      boundary: "already-held",
    });

  const startCore = async (): Promise<CoreStartResult> => {
    if (supervisor.backend === "direct") requireServiceForTun(runtimeSettings.tun, "direct");
    const retryAfterPreparation = Symbol("retry Core start after preparation");
    for (;;) {
      let prepared: PreparedActiveReload | undefined;
      if (!supervisor.isRunning()) {
        try {
          prepared = await profiles.prepareActiveReload();
        } catch (err) {
          // Preserve idempotent start semantics when another mutation brought
          // Core online while this request was preparing its stopped path.
          if (supervisor.isRunning()) continue;
          throw err;
        }
      }

      const preparedForStart = prepared;
      const result = await mutate("start core", async () => {
        if (!preparedForStart && !supervisor.isRunning()) return retryAfterPreparation;
        return lifecycle.start(
          preparedForStart
            ? async () => {
                await commitPreparedReload(preparedForStart, false);
              }
            : undefined,
        );
      });
      if (result !== retryAfterPreparation) return result;
    }
  };

  const withPreparedReloadRetry = async <T>(
    purpose: string,
    action: (prepared: PreparedActiveReload) => Promise<T>,
  ): Promise<T> => {
    if (supervisor.backend === "direct") requireServiceForTun(runtimeSettings.tun, "direct");
    for (let attempt = 0; ; attempt += 1) {
      const prepared = await profiles.prepareActiveReload();
      try {
        return await mutate(purpose, () => action(prepared));
      } catch (err) {
        if (!(err instanceof ProfileConflictError) || attempt >= 1) throw err;
      }
    }
  };

  const context: DaemonContext = {
    layout,
    token,
    startedAt,
    webAuth: new WebAuthManager(),
    profiles,
    settingsService,
    lifecycle,
    supervisor,
    systemProxy,
    gate,
    settings: {
      committed: () => committedSettings,
      runtime: () => runtimeSettings,
    },
    mutate,
    coreControllerEndpoint,
    profileRevision: () => profileRevision,
    startCore,
    restartCore: () =>
      withPreparedReloadRetry("restart core", (prepared) =>
        lifecycle.restart(async () => {
          await commitPreparedReload(prepared, false);
        }),
      ),
    reloadCoreConfig: () =>
      withPreparedReloadRetry("reload core config", (prepared) =>
        commitPreparedReload(prepared, true),
      ),
    shutdown: () => gate.shutdown(),
    closeListener: () => Promise.reject(new Error("listener close is not wired yet")),
    ...(deps.onShutdown ? { onShutdown: deps.onShutdown } : {}),
  };

  return { context, supervisor, lifecycle, token };
}
