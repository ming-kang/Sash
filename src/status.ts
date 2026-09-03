import type { DaemonStatus } from "./contracts.js";
import { currentCoreVersion } from "./core.js";
import { SashDaemonClient } from "./daemon-client.js";
import {
  type DaemonHealthyInfo,
  type DaemonRunningInfo,
  evaluateDaemon,
} from "./daemon-lifecycle.js";
import type { SashLayout } from "./paths.js";
import { ProfileService } from "./profile-service.js";
import type { SashSettings } from "./settings.js";
import type { SystemProxyState } from "./sysproxy.js";
import { type SystemProxyInspection, SystemProxyManager } from "./system-proxy-manager.js";
import { uiInstalled } from "./webui.js";

export const CLI_STATUS_SCHEMA_VERSION = 1 as const;

export type CliDaemonState = "healthy" | "stopped" | "unhealthy";

export interface CliDaemonObservation {
  state: CliDaemonState;
  running: boolean;
  healthy: boolean;
  pid: number | null;
  port: number;
}

export interface CliObservedSystemProxy {
  supported: boolean | null;
  enabled: boolean | null;
  server: string | null;
  details: string | null;
}

export interface CliRuntimeStatus {
  schemaVersion: typeof CLI_STATUS_SCHEMA_VERSION;
  /** True only when every runtime field required by this contract was observed. */
  complete: boolean;
  /** Overall daemon/Core health; null when the daemon status query is unavailable. */
  healthy: boolean | null;
  queryError: string | null;
  daemon: CliDaemonObservation;
  core: {
    running: boolean | null;
    healthy: boolean | null;
    pid: number | null;
    version: string | null;
    installedVersion: string | null;
  };
  systemProxy: {
    desired: boolean;
    daemonApplied: boolean | null;
    osObserved: CliObservedSystemProxy;
  };
  uiInstalled: boolean;
  endpoints: {
    mixedProxy: string;
    controller: string;
    daemonApi: string;
    dashboard: string;
  };
  activeProfile: { id: string; name: string; url: string } | null;
  tun: {
    desired: boolean;
    active: boolean | null;
  };
  paths: {
    root: string;
    config: string;
  };
}

export interface StatusObservationContext {
  layout: SashLayout;
  settings: SashSettings;
}

export interface StatusObservationDependencies {
  evaluateDaemon?: (context: StatusObservationContext) => Promise<DaemonRunningInfo>;
  queryDaemonStatus?: (
    context: StatusObservationContext,
    daemon: DaemonHealthyInfo,
  ) => Promise<DaemonStatus>;
  inspectSystemProxy?: (context: StatusObservationContext) => Promise<SystemProxyInspection>;
  installedCoreVersion?: (context: StatusObservationContext) => string;
  activeProfile?: (
    context: StatusObservationContext,
  ) => { id: string; name: string; url: string } | null;
  hasUi?: (context: StatusObservationContext) => boolean;
}

export interface SystemProxyObservationSource {
  applied: boolean;
  appliedKnown: boolean;
  state?: SystemProxyState;
  stateKnown: boolean;
  queryError?: string;
}

export interface ResolvedSystemProxyObservation {
  daemonApplied: boolean | null;
  osObserved: CliObservedSystemProxy;
  errors: string[];
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, 300) || "unknown error"
  );
}

function addError(errors: string[], message: string): void {
  if (!errors.includes(message)) errors.push(message);
}

function observedSystemProxy(state: SystemProxyState | undefined): CliObservedSystemProxy {
  if (!state) {
    return { supported: null, enabled: null, server: null, details: null };
  }
  return {
    supported: typeof state.supported === "boolean" ? state.supported : null,
    enabled: typeof state.enabled === "boolean" ? state.enabled : null,
    server: typeof state.server === "string" && state.server ? state.server : null,
    details: typeof state.details === "string" && state.details ? state.details : null,
  };
}

function daemonObservation(
  state: DaemonRunningInfo,
  daemonState?: CliDaemonState,
): CliDaemonObservation {
  const resolvedState = daemonState ?? state.kind;
  return {
    state: resolvedState,
    running: state.running,
    healthy: resolvedState === "healthy",
    pid: typeof state.pid === "number" ? state.pid : null,
    port: state.kind === "stopped" ? 0 : (state.port ?? 0),
  };
}

export function resolveObservedSystemProxy(
  source: SystemProxyObservationSource | undefined,
  fallbackDaemonApplied: boolean | null,
  inspection?: SystemProxyInspection,
  inspectionError?: string,
): ResolvedSystemProxyObservation {
  const errors: string[] = [];
  let daemonApplied = fallbackDaemonApplied;
  let osObserved: CliObservedSystemProxy | undefined;

  if (source) {
    daemonApplied = source.appliedKnown ? source.applied : null;
    if (daemonApplied === null) addError(errors, "Daemon-applied proxy state is unavailable");
    if (source.queryError) addError(errors, `System proxy query failed: ${source.queryError}`);
    if (source.stateKnown && source.state) {
      osObserved = observedSystemProxy(source.state);
    }
  }

  if (!osObserved && inspection) {
    if (inspection.queryError) {
      addError(errors, `System proxy query failed: ${inspection.queryError}`);
    }
    if (inspection.stateKnown) {
      osObserved = observedSystemProxy(inspection.state);
    }
  }
  if (inspectionError) addError(errors, inspectionError);

  osObserved ??= observedSystemProxy(undefined);
  if (osObserved.supported === null || osObserved.enabled === null) {
    addError(errors, "OS proxy state is unavailable");
  }
  return { daemonApplied, osObserved, errors };
}

export async function observeSystemProxy(
  context: StatusObservationContext,
  dependencies: StatusObservationDependencies,
  source: SystemProxyObservationSource | undefined,
  fallbackDaemonApplied: boolean | null,
): Promise<ResolvedSystemProxyObservation> {
  let inspection: SystemProxyInspection | undefined;
  let inspectionError: string | undefined;
  if (!source?.stateKnown || !source.state) {
    try {
      inspection = dependencies.inspectSystemProxy
        ? await dependencies.inspectSystemProxy(context)
        : await new SystemProxyManager({ layout: context.layout }).inspect();
    } catch (err) {
      inspectionError = `OS proxy query failed: ${errorText(err)}`;
    }
  }
  return resolveObservedSystemProxy(source, fallbackDaemonApplied, inspection, inspectionError);
}

async function evaluate(
  context: StatusObservationContext,
  dependencies: StatusObservationDependencies,
): Promise<DaemonRunningInfo> {
  return dependencies.evaluateDaemon
    ? dependencies.evaluateDaemon(context)
    : evaluateDaemon(context.layout, context.settings);
}

async function queryStatus(
  context: StatusObservationContext,
  dependencies: StatusObservationDependencies,
  daemon: DaemonHealthyInfo,
): Promise<DaemonStatus> {
  if (dependencies.queryDaemonStatus) {
    return dependencies.queryDaemonStatus(context, daemon);
  }
  return new SashDaemonClient(daemon.port, context.settings.daemonSecret).status();
}

function addObservationErrors(errors: string[], observation: ResolvedSystemProxyObservation): void {
  for (const error of observation.errors) addError(errors, error);
}

export async function collectRuntimeStatus(
  context: StatusObservationContext,
  dependencies: StatusObservationDependencies = {},
): Promise<CliRuntimeStatus> {
  const errors: string[] = [];
  const daemonState = await evaluate(context, dependencies);
  let daemon = daemonObservation(daemonState);
  const installedVersion = dependencies.installedCoreVersion
    ? dependencies.installedCoreVersion(context)
    : currentCoreVersion(context.layout);
  const profile = dependencies.activeProfile
    ? dependencies.activeProfile(context)
    : new ProfileService({
        layout: context.layout,
        settings: () => context.settings,
      }).active();

  let coreRunning: boolean | null = daemonState.running ? null : false;
  let coreHealthy: boolean | null = daemonState.running ? null : false;
  let corePid: number | null = null;
  let coreVersion: string | null = null;
  let tunActive: boolean | null = daemonState.running ? null : false;
  let desiredProxy = context.settings.systemProxy;
  let proxySource: SystemProxyObservationSource | undefined;
  let queriedDaemon = false;

  if (daemonState.kind === "healthy") {
    try {
      const status = await queryStatus(context, dependencies, daemonState);
      queriedDaemon = true;
      daemon = daemonObservation(daemonState, "healthy");
      desiredProxy = status.systemProxy.desired;
      proxySource = {
        applied: status.systemProxy.applied,
        appliedKnown: status.systemProxy.appliedKnown,
        stateKnown: status.systemProxy.stateKnown,
        ...(status.systemProxy.actual ? { state: status.systemProxy.actual } : {}),
        ...(status.systemProxy.queryError ? { queryError: status.systemProxy.queryError } : {}),
      };

      if (typeof status.core.running !== "boolean") {
        addError(errors, "Core running state is unavailable");
      } else if (!status.core.running) {
        coreRunning = false;
        coreHealthy = false;
        tunActive = false;
      } else {
        coreRunning = true;
        coreHealthy = typeof status.core.healthy === "boolean" ? status.core.healthy : null;
        corePid = typeof status.core.pid === "number" ? status.core.pid : null;
        coreVersion =
          typeof status.core.version === "string" && status.core.version
            ? status.core.version
            : null;
        tunActive = typeof status.core.tunActive === "boolean" ? status.core.tunActive : null;
        if (coreHealthy === null) addError(errors, "Core health is unavailable");
        else if (!coreHealthy) addError(errors, "Core controller health probe failed");
        if (corePid === null) addError(errors, "Core PID is unavailable");
        if (coreVersion === null) addError(errors, "Core runtime version is unavailable");
        if (tunActive === null) addError(errors, "Core TUN state is unavailable");
      }
    } catch (err) {
      daemon = daemonObservation(daemonState, "unhealthy");
      addError(errors, `Daemon status query failed: ${errorText(err)}`);
    }
  } else if (daemonState.running) {
    addError(errors, "sashd control API is unavailable");
  }

  const proxyObservation = await observeSystemProxy(
    context,
    dependencies,
    proxySource,
    daemonState.running ? null : false,
  );
  addObservationErrors(errors, proxyObservation);

  const healthy = !daemonState.running
    ? false
    : queriedDaemon
      ? coreRunning === false
        ? false
        : coreHealthy
      : null;
  const activeProfile = profile ? { id: profile.id, name: profile.name, url: profile.url } : null;
  const daemonPort = daemon.port || context.settings.daemonPort;

  return {
    schemaVersion: CLI_STATUS_SCHEMA_VERSION,
    complete: errors.length === 0,
    healthy,
    queryError: errors.length > 0 ? errors.join("; ") : null,
    daemon: { ...daemon, port: daemonPort },
    core: {
      running: coreRunning,
      healthy: coreHealthy,
      pid: corePid,
      version: coreVersion,
      installedVersion: installedVersion || null,
    },
    systemProxy: {
      desired: desiredProxy,
      daemonApplied: proxyObservation.daemonApplied,
      osObserved: proxyObservation.osObserved,
    },
    uiInstalled: dependencies.hasUi ? dependencies.hasUi(context) : uiInstalled(context.layout),
    endpoints: {
      mixedProxy: `127.0.0.1:${context.settings.mixedPort}`,
      controller: context.settings.controller,
      daemonApi: `http://127.0.0.1:${daemonPort}`,
      dashboard: `http://127.0.0.1:${daemonPort}/ui/`,
    },
    activeProfile,
    tun: {
      desired: context.settings.tun,
      active: tunActive,
    },
    paths: {
      root: context.layout.root,
      config: context.layout.configFile,
    },
  };
}

export type StatusHeadline = { level: "info" | "ok" | "warn"; text: string };

export function runtimeStatusHeadline(status: CliRuntimeStatus): StatusHeadline {
  if (status.daemon.state === "stopped") return { level: "info", text: "sash is not running" };
  if (status.daemon.state === "unhealthy" || status.core.running === null) {
    const owner = status.daemon.pid === null ? "" : ` (PID=${status.daemon.pid})`;
    return {
      level: "warn",
      text: `sashd is running${owner}, but runtime status is unavailable`,
    };
  }
  if (status.core.running) {
    const pid = status.core.pid === null ? "unknown" : String(status.core.pid);
    const version = status.core.version ? `, ${status.core.version}` : "";
    return status.core.healthy
      ? {
          level: "ok",
          text: `sashd running (PID=${status.daemon.pid}), core running (PID=${pid}${version})`,
        }
      : {
          level: "warn",
          text: `sashd running (PID=${status.daemon.pid}), core unhealthy (PID=${pid}${version})`,
        };
  }
  return {
    level: "ok",
    text: `sashd running (PID=${status.daemon.pid}), core stopped`,
  };
}

export function formatTunObservation(status: CliRuntimeStatus): string {
  if (!status.tun.desired) {
    if (status.tun.active === true) return "off (runtime active)";
    return status.tun.active === null && status.core.running !== false
      ? "off (runtime unknown)"
      : "off";
  }
  if (status.core.running === false) return "on (core stopped)";
  if (status.core.running === null) return "on (runtime unknown)";
  if (status.tun.active === true) return "on (active)";
  if (status.tun.active === false) return "on (inactive)";
  return "on (unverified)";
}

export function shouldShowTunGuidance(status: CliRuntimeStatus): boolean {
  return (
    status.tun.desired &&
    status.core.running === true &&
    status.core.healthy === true &&
    status.tun.active !== true
  );
}

export function formatObservedProxy(state: CliObservedSystemProxy): string {
  if (state.enabled === null) return "unknown";
  return state.enabled ? `on (${state.server || "unknown server"})` : "off";
}

export function markIncompleteObservation(complete: boolean): void {
  if (!complete && (process.exitCode === undefined || process.exitCode === 0)) {
    process.exitCode = 2;
  }
}
