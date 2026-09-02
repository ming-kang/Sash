import type { DaemonStatus, SystemProxyStatusResponse } from "./contracts.js";
import { currentCoreVersion } from "./core.js";
import { SashDaemonClient } from "./daemon-client.js";
import { type DaemonRunningInfo, evaluateDaemon } from "./daemon-lifecycle.js";
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

export interface CliProxyStatus {
  complete: boolean;
  queryError: string | null;
  daemon: CliDaemonObservation;
  desired: boolean;
  daemonApplied: boolean | null;
  osObserved: CliObservedSystemProxy;
}

export interface StatusObservationContext {
  layout: SashLayout;
  settings: SashSettings;
}

export interface StatusObservationDependencies {
  evaluateDaemon?: (context: StatusObservationContext) => Promise<DaemonRunningInfo>;
  queryDaemonStatus?: (context: StatusObservationContext) => Promise<DaemonStatus>;
  queryDaemonProxy?: (context: StatusObservationContext) => Promise<SystemProxyStatusResponse>;
  inspectSystemProxy?: (context: StatusObservationContext) => SystemProxyInspection;
  installedCoreVersion?: (context: StatusObservationContext) => string;
  activeProfile?: (
    context: StatusObservationContext,
  ) => { id: string; name: string; url: string } | null;
  hasUi?: (context: StatusObservationContext) => boolean;
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
  const resolvedState =
    daemonState ?? (!state.running ? "stopped" : state.healthy ? "healthy" : "unhealthy");
  return {
    state: resolvedState,
    running: state.running,
    healthy: resolvedState === "healthy",
    pid: typeof state.pid === "number" ? state.pid : null,
    port: state.port ?? 0,
  };
}

function inspectSystemProxy(
  context: StatusObservationContext,
  dependencies: StatusObservationDependencies,
  errors: string[],
): SystemProxyInspection | undefined {
  try {
    return dependencies.inspectSystemProxy
      ? dependencies.inspectSystemProxy(context)
      : new SystemProxyManager({ layout: context.layout }).inspect();
  } catch (err) {
    addError(errors, `OS proxy query failed: ${errorText(err)}`);
    return undefined;
  }
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
): Promise<DaemonStatus> {
  if (dependencies.queryDaemonStatus) return dependencies.queryDaemonStatus(context);
  return new SashDaemonClient(context.settings.daemonPort, context.settings.daemonSecret).status();
}

async function queryProxy(
  context: StatusObservationContext,
  dependencies: StatusObservationDependencies,
): Promise<SystemProxyStatusResponse> {
  if (dependencies.queryDaemonProxy) return dependencies.queryDaemonProxy(context);
  return new SashDaemonClient(
    context.settings.daemonPort,
    context.settings.daemonSecret,
  ).getProxy();
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
  let daemonApplied: boolean | null = daemonState.running ? null : false;
  let osObserved: CliObservedSystemProxy | undefined;
  let queriedDaemon = false;

  if (daemonState.running && daemonState.healthy) {
    try {
      const status = await queryStatus(context, dependencies);
      queriedDaemon = true;
      daemon = daemonObservation(daemonState, "healthy");
      desiredProxy =
        typeof status.systemProxy.desired === "boolean"
          ? status.systemProxy.desired
          : context.settings.systemProxy;
      daemonApplied =
        status.systemProxy.appliedKnown === false || typeof status.systemProxy.applied !== "boolean"
          ? null
          : status.systemProxy.applied;
      if (daemonApplied === null) addError(errors, "Daemon-applied proxy state is unavailable");
      if (status.systemProxy.queryError) {
        addError(errors, `System proxy query failed: ${status.systemProxy.queryError}`);
      }
      if (status.systemProxy.stateKnown !== false && status.systemProxy.actual) {
        osObserved = observedSystemProxy(status.systemProxy.actual);
      }

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

  if (!osObserved) {
    const inspection = inspectSystemProxy(context, dependencies, errors);
    if (inspection?.queryError) {
      addError(errors, `System proxy query failed: ${inspection.queryError}`);
    }
    if (inspection?.stateKnown !== false && inspection) {
      osObserved = observedSystemProxy(inspection.state);
    }
  }
  osObserved ??= observedSystemProxy(undefined);
  if (osObserved.supported === null || osObserved.enabled === null) {
    addError(errors, "OS proxy state is unavailable");
  }

  const healthy = !daemonState.running
    ? false
    : queriedDaemon
      ? coreRunning === false
        ? false
        : coreHealthy
      : null;
  const activeProfile = profile ? { id: profile.id, name: profile.name, url: profile.url } : null;

  return {
    schemaVersion: CLI_STATUS_SCHEMA_VERSION,
    complete: errors.length === 0,
    healthy,
    queryError: errors.length > 0 ? errors.join("; ") : null,
    daemon: {
      ...daemon,
      port: context.settings.daemonPort,
    },
    core: {
      running: coreRunning,
      healthy: coreHealthy,
      pid: corePid,
      version: coreVersion,
      installedVersion: installedVersion || null,
    },
    systemProxy: {
      desired: desiredProxy,
      daemonApplied,
      osObserved,
    },
    uiInstalled: dependencies.hasUi ? dependencies.hasUi(context) : uiInstalled(context.layout),
    endpoints: {
      mixedProxy: `127.0.0.1:${context.settings.mixedPort}`,
      controller: context.settings.controller,
      daemonApi: `http://127.0.0.1:${context.settings.daemonPort}`,
      dashboard: `http://127.0.0.1:${context.settings.daemonPort}/ui/`,
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

export async function collectProxyStatus(
  context: StatusObservationContext,
  dependencies: StatusObservationDependencies = {},
): Promise<CliProxyStatus> {
  const errors: string[] = [];
  const daemonState = await evaluate(context, dependencies);
  let daemon = daemonObservation(daemonState);
  let desired = context.settings.systemProxy;
  let daemonApplied: boolean | null = daemonState.running ? null : false;
  let osObserved: CliObservedSystemProxy | undefined;

  if (daemonState.running && daemonState.healthy) {
    try {
      const proxy = await queryProxy(context, dependencies);
      daemon = daemonObservation(daemonState, "healthy");
      desired = typeof proxy.desired === "boolean" ? proxy.desired : desired;
      daemonApplied =
        proxy.appliedKnown === false || typeof proxy.applied !== "boolean" ? null : proxy.applied;
      if (proxy.stateKnown !== false) osObserved = observedSystemProxy(proxy);
      if (daemonApplied === null) addError(errors, "Daemon-applied proxy state is unavailable");
      if (proxy.queryError) addError(errors, `System proxy query failed: ${proxy.queryError}`);
    } catch (err) {
      daemon = daemonObservation(daemonState, "unhealthy");
      addError(errors, `Daemon proxy query failed: ${errorText(err)}`);
    }
  } else if (daemonState.running) {
    addError(errors, "sashd control API is unavailable");
  }

  if (!osObserved) {
    const inspection = inspectSystemProxy(context, dependencies, errors);
    if (inspection?.queryError) {
      addError(errors, `System proxy query failed: ${inspection.queryError}`);
    }
    if (inspection?.stateKnown !== false && inspection) {
      osObserved = observedSystemProxy(inspection.state);
    }
  }
  osObserved ??= observedSystemProxy(undefined);
  if (osObserved.supported === null || osObserved.enabled === null) {
    addError(errors, "OS proxy state is unavailable");
  }

  return {
    complete: errors.length === 0,
    queryError: errors.length > 0 ? errors.join("; ") : null,
    daemon: {
      ...daemon,
      port: context.settings.daemonPort,
    },
    desired,
    daemonApplied,
    osObserved,
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
