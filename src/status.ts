import { loadProfiles } from "./app-state.js";
import { AutostartService } from "./autostart.js";
import type { AutostartStatus } from "./autostart-contract.js";
import type { DaemonStatus } from "./contracts.js";
import { currentCoreVersion } from "./core.js";
import {
  type DaemonHealthyInfo,
  type DaemonRunningInfo,
  evaluateDaemon,
} from "./daemon-lifecycle.js";
import { errorDetail } from "./error-utils.js";
import type { SashLayout } from "./paths.js";
import { getActiveProfile } from "./profiles.js";
import { createDaemonClient } from "./sash-client-node.js";
import type { SashSettings } from "./settings.js";
import type { StatusDelayObservation } from "./status-delay.js";
import type { SystemProxyState } from "./sysproxy.js";
import { type SystemProxyInspection, SystemProxyManager } from "./system-proxy-manager.js";
import { uiInstalled } from "./webui.js";

const CLI_STATUS_SCHEMA_VERSION = 2 as const;

export type CliDaemonState = "healthy" | "stopped" | "unhealthy";

export interface CliDaemonObservation {
  state: CliDaemonState;
  running: boolean;
  healthy: boolean;
  pid: number | null;
  port: number;
  /** The version the running daemon executes; null when it cannot be observed. */
  version: string | null;
}

export interface CliObservedSystemProxy {
  supported: boolean | null;
  enabled: boolean | null;
  server: string | null;
  details: string | null;
}

export interface CliRuntimeStatus {
  schemaVersion: typeof CLI_STATUS_SCHEMA_VERSION;
  /** Present only for an explicit status --delay request. */
  delay?: StatusDelayObservation;
  /** True only when every runtime field required by this contract was observed. */
  complete: boolean;
  /** Overall daemon/Core health; null when the daemon status query is unavailable. */
  healthy: boolean | null;
  queryError: string | null;
  autostart: AutostartStatus;
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
  inspectAutostart?: (context: StatusObservationContext) => Promise<AutostartStatus>;
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
  return errorDetail(err) || "unknown error";
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
  runningVersion?: string,
): CliDaemonObservation {
  const resolvedState = daemonState ?? state.kind;
  return {
    state: resolvedState,
    running: state.running,
    healthy: resolvedState === "healthy",
    pid: typeof state.pid === "number" ? state.pid : null,
    port: state.kind === "stopped" ? 0 : (state.port ?? 0),
    version: runningVersion?.trim() ? runningVersion : null,
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
    if (daemonApplied === null)
      addError(errors, "system proxy: Sash could not confirm what it applied");
    if (source.queryError) addError(errors, `system proxy: ${source.queryError}`);
    if (source.stateKnown && source.state) {
      osObserved = observedSystemProxy(source.state);
    }
  }

  if (!osObserved && inspection) {
    if (inspection.queryError) {
      addError(errors, `system proxy: ${inspection.queryError}`);
    }
    if (inspection.stateKnown) {
      osObserved = observedSystemProxy(inspection.state);
    }
  }
  if (inspectionError) addError(errors, inspectionError);

  osObserved ??= observedSystemProxy(undefined);
  if (osObserved.supported === null || osObserved.enabled === null) {
    addError(errors, "system proxy: could not read the Windows setting");
  }
  return { daemonApplied, osObserved, errors };
}

async function observeSystemProxy(
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
      inspectionError = `system proxy: ${errorText(err)}`;
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
  return createDaemonClient(daemon.port, context.settings.daemonSecret).status();
}

function addObservationErrors(errors: string[], observation: ResolvedSystemProxyObservation): void {
  for (const error of observation.errors) addError(errors, error);
}

export async function collectRuntimeStatus(
  context: StatusObservationContext,
  dependencies: StatusObservationDependencies = {},
): Promise<CliRuntimeStatus> {
  const errors: string[] = [];
  // Autostart exists only at the OS level, so that probe starts now. The OS
  // proxy probe stays lazy: a healthy daemon already reports it, and probing
  // anyway would spend a PowerShell/registry round-trip on a discarded result
  // (observeSystemProxy probes on demand when the daemon did not report one).
  const autostartProbe = Promise.allSettled([
    Promise.resolve().then(() =>
      dependencies.inspectAutostart
        ? dependencies.inspectAutostart(context)
        : new AutostartService({ layout: context.layout }).inspect(),
    ),
  ]);
  const daemonState = await evaluate(context, dependencies);
  let daemon = daemonObservation(daemonState);
  const installedVersion = dependencies.installedCoreVersion
    ? dependencies.installedCoreVersion(context)
    : currentCoreVersion(context.layout);
  const profile = dependencies.activeProfile
    ? dependencies.activeProfile(context)
    : getActiveProfile(loadProfiles(context.layout));

  let coreRunning: boolean | null = daemonState.running ? null : false;
  let coreHealthy: boolean | null = daemonState.running ? null : false;
  let corePid: number | null = null;
  let coreVersion: string | null = null;
  let desiredProxy = context.settings.systemProxy;
  let mixedEndpoint = `127.0.0.1:${context.settings.mixedPort}`;
  let controllerEndpoint = context.settings.controller;
  let proxySource: SystemProxyObservationSource | undefined;
  let queriedDaemon = false;

  if (daemonState.kind === "healthy") {
    try {
      const status = await queryStatus(context, dependencies, daemonState);
      queriedDaemon = true;
      daemon = daemonObservation(
        daemonState,
        "healthy",
        typeof status.daemon.version === "string" ? status.daemon.version : undefined,
      );
      desiredProxy = status.systemProxy.desired;
      controllerEndpoint = status.settings.controller;
      mixedEndpoint = status.core.running
        ? status.configuration.appliedSettings
          ? `127.0.0.1:${status.configuration.appliedSettings.mixedPort}`
          : "unknown"
        : `127.0.0.1:${status.settings.mixedPort}`;
      proxySource = {
        applied: status.systemProxy.applied,
        appliedKnown: status.systemProxy.appliedKnown,
        stateKnown: status.systemProxy.stateKnown,
        ...(status.systemProxy.actual ? { state: status.systemProxy.actual } : {}),
        ...(status.systemProxy.queryError ? { queryError: status.systemProxy.queryError } : {}),
      };

      if (typeof status.core.running !== "boolean") {
        addError(errors, "Core: state unknown");
      } else if (!status.core.running) {
        coreRunning = false;
        coreHealthy = false;
      } else {
        coreRunning = true;
        coreHealthy = typeof status.core.healthy === "boolean" ? status.core.healthy : null;
        corePid = typeof status.core.pid === "number" ? status.core.pid : null;
        coreVersion =
          typeof status.core.version === "string" && status.core.version
            ? status.core.version
            : null;
        if (coreHealthy === null) addError(errors, "Core: health unknown");
        else if (!coreHealthy) addError(errors, "Core: its control API is not answering");
        if (corePid === null) addError(errors, "Core: process id unknown");
        if (coreVersion === null) addError(errors, "Core: version unknown");
      }
    } catch (err) {
      daemon = daemonObservation(daemonState, "unhealthy");
      addError(errors, `Sash API request failed: ${errorText(err)}`);
    }
  } else if (daemonState.running) {
    addError(errors, "Sash API is unreachable");
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
  const [autostartProbeResult] = await autostartProbe;
  const autostart: AutostartStatus =
    autostartProbeResult.status === "fulfilled"
      ? autostartProbeResult.value
      : { state: "unknown", canEnable: false, reason: errorText(autostartProbeResult.reason) };
  if (autostart.state === "unknown") {
    addError(errors, `start at login: ${autostart.reason ?? "could not read the state"}`);
  }

  return {
    schemaVersion: CLI_STATUS_SCHEMA_VERSION,
    complete: errors.length === 0,
    healthy,
    queryError: errors.length > 0 ? errors.join("; ") : null,
    autostart,
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
      mixedProxy: mixedEndpoint,
      controller: controllerEndpoint,
      daemonApi: `http://127.0.0.1:${daemonPort}`,
      dashboard: `http://127.0.0.1:${daemonPort}/ui/`,
    },
    activeProfile,
    paths: {
      root: context.layout.root,
      config: context.layout.configFile,
    },
  };
}

export type StatusHeadline = { level: "info" | "ok" | "warn"; text: string };

export function runtimeStatusHeadline(status: CliRuntimeStatus): StatusHeadline {
  if (status.daemon.state === "stopped") return { level: "info", text: "Sash is not running" };
  if (status.daemon.state === "unhealthy" || status.core.running === null) {
    const owner = status.daemon.pid === null ? "" : ` (PID ${status.daemon.pid})`;
    return {
      level: "warn",
      text: `Sash is not responding${owner} — run sash logs --daemon`,
    };
  }
  if (status.core.running) {
    const pid = status.core.pid === null ? "unknown" : String(status.core.pid);
    const version = status.core.version ? ` (${status.core.version})` : "";
    return status.core.healthy
      ? { level: "ok", text: `Sash is running · Core running${version}` }
      : {
          level: "warn",
          text: `Sash is running · Core unhealthy (PID ${pid})`,
        };
  }
  return {
    level: "ok",
    text: "Sash is running · Core stopped",
  };
}

/**
 * One line for the three facts about the system proxy: whether the user wants
 * it, and what Windows actually has. "Wanted but not applied", "off but still
 * set" and "could not read" are the states a user has to act on, so they name
 * the next step instead of the internal desired/applied/observed split.
 */
export function formatSystemProxyLine(desired: boolean, observed: CliObservedSystemProxy): string {
  if (observed.supported === false) return "not supported on this system";
  if (observed.enabled === null) return "unknown — could not read the Windows setting";
  if (desired && observed.enabled) return "on";
  if (desired) return "on — not applied to Windows yet; run sash proxy on";
  if (observed.enabled) {
    const server = observed.server ? ` to ${observed.server}` : "";
    return `off — Windows is still set${server}; run sash proxy off`;
  }
  return "off";
}

/**
 * Start-at-login states in the user's terms. Only suggest the repair command
 * when this installation can actually register one: a source checkout or a
 * linked package reports why instead, so the advice is never a command that
 * fails.
 */
export function formatAutostart(status: {
  state: string;
  canEnable?: boolean;
  reason: string | null;
}): string {
  const { state, reason } = status;
  const repairable = status.canEnable !== false;
  switch (state) {
    case "on":
      return "on";
    case "off":
      return repairable ? "off" : (reason ?? "not available for this installation");
    case "stale":
      return repairable ? "needs repair — run sash auto on" : (reason ?? "needs repair");
    case "disabled":
      return repairable
        ? "disabled in Windows — run sash auto on to restore it"
        : (reason ?? "disabled in Windows");
    case "unsupported":
      return reason ?? "not supported on this system";
    default:
      return reason ? `unknown — ${reason}` : "unknown";
  }
}

export function markIncompleteObservation(complete: boolean): void {
  if (!complete && (process.exitCode === undefined || process.exitCode === 0)) {
    process.exitCode = 2;
  }
}
