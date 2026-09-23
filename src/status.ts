import { loadProfiles } from "./app-state.js";
import type { AutostartStatus } from "./autostart/contract.js";
import { type LoginStartRecord, readLoginStartRecord } from "./autostart/login-record.js";
import { AutostartService } from "./autostart/service.js";
import type { DaemonStatus } from "./contracts.js";
import { currentCoreVersion } from "./core.js";
import type { CoreUpdateProgress } from "./core-update.js";
import {
  type DaemonHealthyInfo,
  type DaemonRunningInfo,
  evaluateDaemon,
} from "./daemon-lifecycle.js";
import { errorDetail } from "./error-utils.js";
import type { DownloadTransport } from "./http.js";
import type { SashLayout } from "./paths.js";
import { getActiveProfile } from "./profiles.js";
import { createDaemonClient } from "./sash-client-node.js";
import type { SashSettings } from "./settings.js";
import type { StatusDelayObservation } from "./status-delay.js";
import { type SystemProxyInspection, SystemProxyManager } from "./sysproxy/manager.js";
import type { SystemProxyState } from "./sysproxy/types.js";
import { uiInstalled } from "./webui.js";

const CLI_STATUS_SCHEMA_VERSION = 2 as const;

/** Human-readable transport for Core downloads, matching the CLI status line. */
function describeDownloadTransport(transport: DownloadTransport): string {
  return transport.source === "core"
    ? `Sash's own Core proxy: ${transport.uri}`
    : `proxy environment variable: ${transport.uri}`;
}

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
  /** Present only while the daemon stages or installs a Core binary. */
  coreUpdate?: CoreUpdateProgress;
  /** Present only when the daemon answered; describes how Core downloads leave. */
  downloadProxy?: string;
  /** True only when every runtime field required by this contract was observed. */
  complete: boolean;
  /** Overall daemon/Core health; null when the daemon status query is unavailable. */
  healthy: boolean | null;
  queryError: string | null;
  autostart: AutostartStatus;
  /** Last login-start outcome; null when none was recorded. */
  loginStart: LoginStartRecord | null;
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
  queryDaemonAutostart?: (
    context: StatusObservationContext,
    daemon: DaemonHealthyInfo,
  ) => Promise<AutostartStatus>;
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

async function queryAutostart(
  context: StatusObservationContext,
  dependencies: StatusObservationDependencies,
  daemon: DaemonHealthyInfo,
): Promise<AutostartStatus> {
  if (dependencies.queryDaemonAutostart) {
    return dependencies.queryDaemonAutostart(context, daemon);
  }
  if (dependencies.queryDaemonStatus && dependencies.inspectAutostart) {
    return dependencies.inspectAutostart(context);
  }
  return createDaemonClient(daemon.port, context.settings.daemonSecret).autostartStatus();
}

async function inspectLocalAutostart(
  context: StatusObservationContext,
  dependencies: StatusObservationDependencies,
): Promise<AutostartStatus> {
  return dependencies.inspectAutostart
    ? dependencies.inspectAutostart(context)
    : new AutostartService({ layout: context.layout }).inspect();
}

async function observeAutostart(
  context: StatusObservationContext,
  dependencies: StatusObservationDependencies,
  daemonState: DaemonRunningInfo,
  daemonOnline: boolean,
): Promise<AutostartStatus> {
  if (daemonOnline && daemonState.kind === "healthy") {
    try {
      return await queryAutostart(context, dependencies, daemonState);
    } catch {
      // Fall back to local probe
    }
  }
  try {
    return await inspectLocalAutostart(context, dependencies);
  } catch (err) {
    return { state: "unknown", canEnable: false, reason: errorText(err) };
  }
}

function addObservationErrors(errors: string[], observation: ResolvedSystemProxyObservation): void {
  for (const error of observation.errors) addError(errors, error);
}

export interface CliStatusFromDaemonOptions {
  installedCoreVersion?: string | null;
  uiInstalled?: boolean;
  activeProfile?: { id: string; name: string; url: string } | null;
  proxyObservation?: ResolvedSystemProxyObservation;
  daemonPort?: number;
  daemonPid?: number | null;
}

/**
 * Deterministically maps a complete daemon status snapshot and autostart state
 * to the CLI runtime status contract.
 */
export function cliStatusFromDaemonStatus(
  context: StatusObservationContext,
  status: DaemonStatus,
  autostart: AutostartStatus,
  options: CliStatusFromDaemonOptions = {},
): CliRuntimeStatus {
  const errors: string[] = [];
  const daemonPort = options.daemonPort ?? status.daemon.port ?? context.settings.daemonPort;
  const daemonPid =
    options.daemonPid !== undefined
      ? options.daemonPid
      : typeof status.daemon.pid === "number"
        ? status.daemon.pid
        : null;
  const daemon: CliDaemonObservation = {
    state: "healthy",
    running: true,
    healthy: true,
    pid: daemonPid,
    port: daemonPort,
    version:
      typeof status.daemon.version === "string" && status.daemon.version.trim()
        ? status.daemon.version
        : null,
  };

  const desiredProxy = status.systemProxy.desired;
  const controllerEndpoint = status.settings.controller;
  const mixedEndpoint = status.core.running
    ? status.configuration.appliedSettings
      ? `127.0.0.1:${status.configuration.appliedSettings.mixedPort}`
      : "unknown"
    : `127.0.0.1:${status.settings.mixedPort}`;

  const proxySource: SystemProxyObservationSource = {
    applied: status.systemProxy.applied,
    appliedKnown: status.systemProxy.appliedKnown,
    stateKnown: status.systemProxy.stateKnown,
    ...(status.systemProxy.actual ? { state: status.systemProxy.actual } : {}),
    ...(status.systemProxy.queryError ? { queryError: status.systemProxy.queryError } : {}),
  };

  let coreRunning: boolean;
  let coreHealthy: boolean | null;
  let corePid: number | null = null;
  let coreVersion: string | null = null;

  if (typeof status.core.running !== "boolean") {
    addError(errors, "Core: state unknown");
    coreRunning = false;
    coreHealthy = null;
  } else if (!status.core.running) {
    coreRunning = false;
    coreHealthy = false;
  } else {
    coreRunning = true;
    coreHealthy = typeof status.core.healthy === "boolean" ? status.core.healthy : null;
    corePid = typeof status.core.pid === "number" ? status.core.pid : null;
    coreVersion =
      typeof status.core.version === "string" && status.core.version ? status.core.version : null;
    if (coreHealthy === null) addError(errors, "Core: health unknown");
    else if (!coreHealthy) addError(errors, "Core: its control API is not answering");
    if (corePid === null) addError(errors, "Core: process id unknown");
    if (coreVersion === null) addError(errors, "Core: version unknown");
  }

  const proxyObservation =
    options.proxyObservation ?? resolveObservedSystemProxy(proxySource, null);
  addObservationErrors(errors, proxyObservation);

  const healthy = coreRunning === false ? false : coreHealthy;
  const activeProfile =
    options.activeProfile !== undefined
      ? options.activeProfile
      : status.activeProfile
        ? {
            id: status.activeProfile.id,
            name: status.activeProfile.name,
            url: status.activeProfile.url,
          }
        : null;

  if (autostart.state === "unknown") {
    addError(errors, `start at login: ${autostart.reason ?? "could not read the state"}`);
  }
  const loginStart = readLoginStartRecord(context.layout) ?? null;
  const installedVersion =
    options.installedCoreVersion !== undefined
      ? options.installedCoreVersion
      : currentCoreVersion(context.layout);
  const hasUi =
    options.uiInstalled !== undefined ? options.uiInstalled : uiInstalled(context.layout);

  return {
    schemaVersion: CLI_STATUS_SCHEMA_VERSION,
    complete: errors.length === 0,
    healthy,
    queryError: errors.length > 0 ? errors.join("; ") : null,
    autostart,
    loginStart,
    daemon,
    core: {
      running: coreRunning,
      healthy: coreHealthy,
      pid: corePid,
      version: coreVersion,
      installedVersion: installedVersion || null,
    },
    ...(status.coreUpdate ? { coreUpdate: status.coreUpdate } : {}),
    ...(status.downloadTransport
      ? { downloadProxy: describeDownloadTransport(status.downloadTransport) }
      : {}),
    systemProxy: {
      desired: desiredProxy,
      daemonApplied: proxyObservation.daemonApplied,
      osObserved: proxyObservation.osObserved,
    },
    uiInstalled: hasUi,
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
    : getActiveProfile(loadProfiles(context.layout));

  const desiredProxy = context.settings.systemProxy;
  const mixedEndpoint = `127.0.0.1:${context.settings.mixedPort}`;
  const controllerEndpoint = context.settings.controller;

  if (daemonState.kind === "healthy") {
    try {
      const status = await queryStatus(context, dependencies, daemonState);
      const proxySource: SystemProxyObservationSource = {
        applied: status.systemProxy.applied,
        appliedKnown: status.systemProxy.appliedKnown,
        stateKnown: status.systemProxy.stateKnown,
        ...(status.systemProxy.actual ? { state: status.systemProxy.actual } : {}),
        ...(status.systemProxy.queryError ? { queryError: status.systemProxy.queryError } : {}),
      };
      const [proxyObservation, autostart] = await Promise.all([
        observeSystemProxy(context, dependencies, proxySource, null),
        observeAutostart(context, dependencies, daemonState, true),
      ]);
      return cliStatusFromDaemonStatus(context, status, autostart, {
        daemonPort: daemonState.port,
        daemonPid: typeof daemonState.pid === "number" ? daemonState.pid : undefined,
        installedCoreVersion: dependencies.installedCoreVersion
          ? dependencies.installedCoreVersion(context)
          : undefined,
        uiInstalled: dependencies.hasUi ? dependencies.hasUi(context) : undefined,
        activeProfile: dependencies.activeProfile
          ? profile
            ? { id: profile.id, name: profile.name, url: profile.url }
            : null
          : undefined,
        proxyObservation,
      });
    } catch (err) {
      daemon = daemonObservation(daemonState, "unhealthy");
      addError(errors, `local API request failed: ${errorText(err)}`);
    }
  } else if (daemonState.running) {
    addError(errors, "the local API is unreachable");
  }

  // Reaching here means the daemon's own status was never read: either Sash is
  // stopped, or its local API did not answer. Core facts stay unobserved, which
  // reads as unknown while Sash runs and as a definitive "no" once it is not.
  const observed: boolean | null = daemonState.running ? null : false;
  const [proxyObservation, autostart] = await Promise.all([
    observeSystemProxy(context, dependencies, undefined, observed),
    observeAutostart(context, dependencies, daemonState, false),
  ]);
  addObservationErrors(errors, proxyObservation);

  const activeProfile = profile ? { id: profile.id, name: profile.name, url: profile.url } : null;
  const daemonPort = daemon.port || context.settings.daemonPort;
  if (autostart.state === "unknown") {
    addError(errors, `start at login: ${autostart.reason ?? "could not read the state"}`);
  }
  const loginStart = readLoginStartRecord(context.layout) ?? null;

  return {
    schemaVersion: CLI_STATUS_SCHEMA_VERSION,
    complete: errors.length === 0,
    healthy: observed,
    queryError: errors.length > 0 ? errors.join("; ") : null,
    autostart,
    loginStart,
    daemon: { ...daemon, port: daemonPort },
    core: {
      running: observed,
      healthy: observed,
      pid: null,
      version: null,
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
    return {
      level: "warn",
      text: "Sash is not responding — run sash logs --daemon",
    };
  }
  if (status.core.running) {
    const version = status.core.version ? ` (${status.core.version})` : "";
    return status.core.healthy
      ? { level: "ok", text: `Sash is running · Core running${version}` }
      : {
          level: "warn",
          text: "Sash is running · Core unhealthy — run sash logs --errors",
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

/** One appended fact when the last login start failed, otherwise nothing. */
export function formatLoginStartSuffix(record: LoginStartRecord | null): string {
  if (!record || record.ok) return "";
  return " · last login start failed — run sash doctor";
}

export function markIncompleteObservation(complete: boolean): void {
  if (!complete && (process.exitCode === undefined || process.exitCode === 0)) {
    process.exitCode = 2;
  }
}
