import crypto from "node:crypto";
import { SashStateStore } from "../app-state.js";
import { AutostartService, type AutostartServiceOptions } from "../autostart/service.js";
import type { resolveCoreRelease, stageCore } from "../core.js";
import { errorMessage } from "../error-utils.js";
import type { GeodataSeedResult } from "../geodata-seed.js";
import type { GeneratedConfig, SubscriptionFetch } from "../mihomo-config.js";
import { currentPackageRoot, readSashPackageInfo } from "../package-info.js";
import type { SashLayout } from "../paths.js";
import { ProfileService } from "../profile-service.js";
import { getActiveProfile } from "../profiles.js";
import { RuntimeLifecycle, runtimeDelta } from "../runtime-lifecycle.js";
import type { SashSettings } from "../settings.js";
import { SettingsService } from "../settings-service.js";
import { CoreSupervisor } from "../supervisor.js";
import { type SystemProxyController, SystemProxyManager } from "../sysproxy/manager.js";
import { WebAuthManager } from "./auth.js";
import { type DaemonContext, DaemonGate } from "./context.js";
import { CoreControlService } from "./core-service.js";
import { createEventObserver, DaemonEvents } from "./events.js";
import type { DaemonScheduler } from "./scheduler.js";

export interface DaemonDeps {
  layout: SashLayout;
  packageRoot?: string;
  state?: SashStateStore;
  settings?: SashSettings;
  supervisor?: CoreSupervisor;
  systemProxy?: SystemProxyController;
  autostart?: AutostartServiceOptions;
  token?: string;
  fetchProfileFn?: (url: string, signal?: AbortSignal) => Promise<SubscriptionFetch>;
  validateConfigFn?: (
    generated: GeneratedConfig,
    executable: string,
    signal: AbortSignal,
  ) => Promise<void> | void;
  stageCoreFn?: typeof stageCore;
  resolveCoreReleaseFn?: typeof resolveCoreRelease;
  seedGeodataFn?: (file: string, options: { signal: AbortSignal }) => Promise<GeodataSeedResult>;
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
  let profiles: ProfileService;
  let coreControl: CoreControlService;
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
  const cancelPreparations = (): void => {
    coreControl.cancelPreparation();
    profiles.cancelDownloads();
  };
  gate = new DaemonGate(() => lifecycle.stop(), cancelPreparations, {
    onChange: () => events.notify(),
  });
  const mutate = <T>(action: () => T | Promise<T>) => gate.mutate(action);
  profiles = new ProfileService({
    layout,
    state,
    canCleanTemp: () => !coreControl.isUpdating,
    commit: mutate,
    assertMutable: () => gate.assertMutable(),
    fetchProfile: deps.fetchProfileFn,
    reconcileRuntime: () => coreControl.reconcileSaved(),
  });
  const settingsService = new SettingsService({ state, commit: mutate, lifecycle, supervisor });
  coreControl = new CoreControlService({
    layout,
    state,
    supervisor,
    lifecycle,
    commit: mutate,
    assertMutable: () => gate.assertMutable(),
    onProgress: () => events.notify(),
    ...(deps.validateConfigFn ? { validateConfigFn: deps.validateConfigFn } : {}),
    ...(deps.stageCoreFn ? { stageCoreFn: deps.stageCoreFn } : {}),
    ...(deps.resolveCoreReleaseFn ? { resolveCoreReleaseFn: deps.resolveCoreReleaseFn } : {}),
    ...(deps.seedGeodataFn ? { seedGeodataFn: deps.seedGeodataFn } : {}),
  });

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
    systemProxy,
    autostart: new AutostartService({
      layout,
      ...deps.autostart,
      onChange: () => events.notify(),
    }),
    gate,
    events,
    mutate,
    settings: { committed: settings, runtime: () => lifecycle.settings() },
    stateRevision: () => state.snapshot().revision,
    pendingApply: () => {
      const saved = state.snapshot();
      const active = getActiveProfile(saved.profiles);
      return runtimeDelta(lifecycle.configuration(), {
        profile: active ? { id: active.id, revision: active.revision } : null,
        settings: saved.settings,
      }).pending;
    },
    core: coreControl,
    shutdown: () => gate.shutdown(),
    closeListener: () => Promise.reject(new Error("Listener is not ready")),
    ...(deps.onShutdown ? { onShutdown: deps.onShutdown } : {}),
  };
  return { context, supervisor, lifecycle, token };
}
