import crypto from "node:crypto";
import { SashStateStore } from "../app-state.js";
import { AutostartService, type AutostartServiceOptions } from "../autostart/service.js";
import type { resolveCoreRelease, stageCore } from "../core.js";
import { createCoreRunner } from "../core-runner.js";
import { type CoreEngine, mihomoEngine } from "../engine/index.js";
import { errorMessage } from "../error-utils.js";
import type { GeodataSeedResult } from "../geodata-seed.js";
import type { GeneratedConfig, SubscriptionFetch } from "../mihomo-config.js";
import { currentPackageRoot, readSashPackageInfo } from "../package-info.js";
import type { SashLayout } from "../paths.js";
import { PluginRegistry } from "../plugins/index.js";
import { ProfileService } from "../profile-service.js";
import { RuntimeLifecycle } from "../runtime-lifecycle.js";
import type { SashSettings } from "../settings.js";
import { SettingsService } from "../settings-service.js";
import { CoreSupervisor } from "../supervisor.js";
import { type SystemProxyController, SystemProxyManager } from "../sysproxy/manager.js";
import { TunGuard, type TunGuardLike } from "../tun-guard.js";
import { createTunPlatform } from "../tun-platform/index.js";
import { type TunPlatform, TunService } from "../tun-service.js";
import { resolveUiDir } from "../webui.js";
import { type DaemonContext, DaemonGate } from "./context.js";
import { CoreControlService } from "./core-service.js";
import { createEventObserver, DaemonEvents } from "./events.js";
import type { DaemonScheduler } from "./scheduler.js";

export interface DaemonDeps {
  layout: SashLayout;
  packageRoot?: string;
  /** Serves the dashboard from this directory instead of the package's own. */
  uiDir?: string;
  state?: SashStateStore;
  settings?: SashSettings;
  supervisor?: CoreSupervisor;
  systemProxy?: SystemProxyController;
  tunPlatform?: TunPlatform;
  autostart?: AutostartServiceOptions;
  bootId?: string;
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
  tunGuard?: TunGuardLike;
  engine?: CoreEngine;
  plugins?: PluginRegistry;
  onShutdown?: () => void;
  scheduler?: DaemonScheduler;
}

export interface DaemonApp {
  context: DaemonContext;
  supervisor: CoreSupervisor;
  lifecycle: RuntimeLifecycle;
  bootId: string;
}

export function buildDaemonContext(deps: DaemonDeps): DaemonApp {
  const { layout, uiDir } = deps;
  const packageRoot = deps.packageRoot ?? currentPackageRoot();
  const packageInfo = readSashPackageInfo(packageRoot);
  const state = deps.state ?? new SashStateStore(layout, deps.settings);
  const settings = () => state.snapshot().settings;
  const bootId = deps.bootId ?? crypto.randomBytes(24).toString("hex");
  const systemProxy = deps.systemProxy ?? new SystemProxyManager({ layout });
  const tunPlatform = deps.tunPlatform ?? createTunPlatform();
  const tun = new TunService(tunPlatform, layout);
  const engine = deps.engine ?? mihomoEngine;
  let lifecycle: RuntimeLifecycle;
  let gate: DaemonGate;
  let profiles: ProfileService;
  let coreControl: CoreControlService;
  let coreRecovery: Promise<void> | undefined;
  const events = new DaemonEvents(createEventObserver(() => context));
  const supervisor =
    deps.supervisor ??
    new CoreSupervisor({
      layout,
      engine,
      runner: createCoreRunner({
        layout,
        engine,
        ...(tunPlatform.host ? { tunHost: tunPlatform.host(layout) } : {}),
        tunExpected: () => settings().tun.enable,
      }),
      settings: () => lifecycle?.settings() ?? settings(),
      onExit: () => {
        const expected = lifecycle.configuration();
        return gate
          .mutate(() => lifecycle.handleUnexpectedCoreExit())
          .then(() => {
            if (!expected || coreRecovery) return;
            const current = (async () => {
              try {
                await lifecycle.restoreCoreSessionWithRetries(
                  expected,
                  (action) => gate.mutate(action),
                  () => gate.isClosing,
                );
              } catch (error: unknown) {
                console.error(`[sashd] Core recovery failed: ${errorMessage(error)}`);
              }
            })();
            coreRecovery = current;
            void current.then(() => {
              if (coreRecovery === current) coreRecovery = undefined;
            });
          })
          .catch((error: unknown) => {
            console.error(`[sashd] Core exit cleanup failed: ${errorMessage(error)}`);
          });
      },
    });
  const tunGuard = deps.tunGuard ?? new TunGuard();
  lifecycle = new RuntimeLifecycle({
    layout,
    supervisor,
    systemProxy,
    settings,
    engine,
    tun,
    tunGuard,
    controllerProbe: deps.controllerProbe,
  });
  const cancelPreparations = (): void => {
    coreControl.cancelPreparation();
    profiles.cancelDownloads();
  };
  gate = new DaemonGate(() => lifecycle.stop({ final: true }), cancelPreparations, {
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
    engine,
    supervisor,
    lifecycle,
    commit: mutate,
    assertMutable: () => gate.assertMutable(),
    onProgress: () => events.notify(),
    ...(deps.validateConfigFn ? { validateConfigFn: deps.validateConfigFn } : {}),
    ...(deps.stageCoreFn ? { stageCoreFn: deps.stageCoreFn } : {}),
    ...(deps.resolveCoreReleaseFn ? { resolveCoreReleaseFn: deps.resolveCoreReleaseFn } : {}),
    ...(deps.seedGeodataFn ? { seedGeodataFn: deps.seedGeodataFn } : {}),
    plugins: deps.plugins ?? new PluginRegistry(layout.pluginsDir),
  });

  const context: DaemonContext = {
    layout,
    engine,
    state,
    bootId,
    startedAt: new Date().toISOString(),
    version: packageInfo.version,
    uiDir: uiDir === undefined ? () => resolveUiDir() : () => uiDir,
    profiles,
    settingsService,
    lifecycle,
    supervisor,
    systemProxy,
    tun,
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
    pendingApply: () => coreControl.pendingApply,
    core: coreControl,
    shutdown: () => gate.shutdown(),
    closeListener: () => Promise.reject(new Error("Listener is not ready")),
    ...(deps.onShutdown ? { onShutdown: deps.onShutdown } : {}),
  };
  return { context, supervisor, lifecycle, bootId };
}
