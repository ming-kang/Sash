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
  delay?: StatusDelayObservation;
  coreUpdate?: CoreUpdateProgress;
  downloadProxy?: string;
  downloadTransport?: DownloadTransport;
  complete: boolean;
  healthy: boolean | null;
  queryError: string | null;
  autostart: AutostartStatus;
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

export interface StatusObserver {
  evaluateDaemon(context: StatusObservationContext): Promise<DaemonRunningInfo>;
  queryDaemonStatus(
    context: StatusObservationContext,
    daemon: DaemonHealthyInfo,
  ): Promise<DaemonStatus>;
  queryDaemonAutostart(
    context: StatusObservationContext,
    daemon: DaemonHealthyInfo,
  ): Promise<AutostartStatus>;
  inspectSystemProxy(context: StatusObservationContext): Promise<SystemProxyInspection>;
  inspectAutostart(context: StatusObservationContext): Promise<AutostartStatus>;
  installedCoreVersion(context: StatusObservationContext): string;
  activeProfile(context: StatusObservationContext): DaemonStatus["activeProfile"];
  hasUi(context: StatusObservationContext): boolean;
}

export type StatusObservationDependencies = Partial<StatusObserver>;

function statusObserver(dependencies: StatusObservationDependencies = {}): StatusObserver {
  return {
    evaluateDaemon:
      dependencies.evaluateDaemon ??
      ((context) => evaluateDaemon(context.layout, context.settings)),
    queryDaemonStatus:
      dependencies.queryDaemonStatus ??
      ((context, daemon) =>
        createDaemonClient(daemon.port, context.settings.daemonSecret).status()),
    queryDaemonAutostart:
      dependencies.queryDaemonAutostart ??
      ((context, daemon) =>
        createDaemonClient(daemon.port, context.settings.daemonSecret).autostartStatus()),
    inspectSystemProxy:
      dependencies.inspectSystemProxy ??
      ((context) => new SystemProxyManager({ layout: context.layout }).inspect()),
    inspectAutostart:
      dependencies.inspectAutostart ??
      ((context) => new AutostartService({ layout: context.layout }).inspect()),
    installedCoreVersion:
      dependencies.installedCoreVersion ?? ((context) => currentCoreVersion(context.layout)),
    activeProfile:
      dependencies.activeProfile ??
      ((context) => {
        const profile = getActiveProfile(loadProfiles(context.layout));
        return profile ? { id: profile.id, name: profile.name, url: profile.url } : null;
      }),
    hasUi: dependencies.hasUi ?? ((context) => uiInstalled(context.layout)),
  };
}

const DEFAULT_STATUS_OBSERVER = statusObserver();

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
  context: StatusObservationContext,
  state: DaemonRunningInfo,
): CliDaemonObservation {
  return {
    state: state.kind,
    running: state.running,
    healthy: state.healthy,
    pid: state.pid ?? null,
    port: (state.kind === "stopped" ? 0 : state.port) || context.settings.daemonPort,
    version: null,
  };
}

function onlineDaemonObservation(
  context: StatusObservationContext,
  status: DaemonStatus,
  identity: Pick<DaemonHealthyInfo, "pid" | "port"> = status.daemon,
): CliDaemonObservation {
  return {
    state: "healthy",
    running: true,
    healthy: true,
    pid: typeof identity.pid === "number" ? identity.pid : null,
    port: identity.port ?? context.settings.daemonPort,
    version:
      typeof status.daemon.version === "string" && status.daemon.version.trim()
        ? status.daemon.version
        : null,
  };
}

export function resolveObservedSystemProxy(
  source: DaemonStatus["systemProxy"] | undefined,
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
    if (source.stateKnown && source.actual) {
      osObserved = observedSystemProxy(source.actual);
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
  observer: StatusObserver,
  source: DaemonStatus["systemProxy"] | undefined,
  fallbackDaemonApplied: boolean | null,
): Promise<ResolvedSystemProxyObservation> {
  let inspection: SystemProxyInspection | undefined;
  let inspectionError: string | undefined;
  if (!source?.stateKnown || !source.actual) {
    try {
      inspection = await observer.inspectSystemProxy(context);
    } catch (err) {
      inspectionError = `system proxy: ${errorText(err)}`;
    }
  }
  return resolveObservedSystemProxy(source, fallbackDaemonApplied, inspection, inspectionError);
}

async function observeAutostart(
  context: StatusObservationContext,
  observer: StatusObserver,
  daemon: DaemonHealthyInfo | undefined,
): Promise<AutostartStatus> {
  if (daemon) {
    try {
      return await observer.queryDaemonAutostart(context, daemon);
    } catch {}
  }
  try {
    return await observer.inspectAutostart(context);
  } catch (err) {
    return { state: "unknown", canEnable: false, reason: errorText(err) };
  }
}

function addObservationErrors(errors: string[], observation: ResolvedSystemProxyObservation): void {
  for (const error of observation.errors) addError(errors, error);
}

interface RuntimeStatusObservation {
  daemon: CliDaemonObservation;
  status: DaemonStatus | undefined;
  proxy: ResolvedSystemProxyObservation;
  autostart: AutostartStatus;
  activeProfile: DaemonStatus["activeProfile"];
  installedVersion: string | null;
  uiInstalled: boolean;
  loginStart: LoginStartRecord | null;
  errors: string[];
}

function readLocalStatusFacts(context: StatusObservationContext, observer: StatusObserver) {
  return {
    installedVersion: observer.installedCoreVersion(context) || null,
    uiInstalled: observer.hasUi(context),
    loginStart: readLoginStartRecord(context.layout) ?? null,
  };
}

/** One projection for HTTP observations, disconnected observations, and SSE snapshots. */
function projectRuntimeStatus(
  context: StatusObservationContext,
  observation: RuntimeStatusObservation,
): CliRuntimeStatus {
  const { daemon, status, proxy, autostart } = observation;
  const errors = [...observation.errors];
  const observed = daemon.running ? null : false;
  const core: CliRuntimeStatus["core"] = {
    running: observed,
    healthy: observed,
    pid: null,
    version: null,
    installedVersion: observation.installedVersion,
  };
  if (status) {
    if (typeof status.core.running !== "boolean") {
      addError(errors, "Core: state unknown");
      core.running = false;
      core.healthy = null;
    } else if (!status.core.running) {
      core.running = false;
      core.healthy = false;
    } else {
      core.running = true;
      core.healthy = typeof status.core.healthy === "boolean" ? status.core.healthy : null;
      core.pid = typeof status.core.pid === "number" ? status.core.pid : null;
      core.version =
        typeof status.core.version === "string" && status.core.version ? status.core.version : null;
      if (core.healthy === null) addError(errors, "Core: health unknown");
      else if (!core.healthy) addError(errors, "Core: its control API is not answering");
      if (core.pid === null) addError(errors, "Core: process id unknown");
      if (core.version === null) addError(errors, "Core: version unknown");
    }
  }
  addObservationErrors(errors, proxy);
  if (autostart.state === "unknown") {
    addError(errors, `start at login: ${autostart.reason ?? "could not read the state"}`);
  }
  const settings = status ? status.settings : context.settings;
  const mixedEndpoint = status?.core.running
    ? status.configuration.appliedSettings
      ? `127.0.0.1:${status.configuration.appliedSettings.mixedPort}`
      : "unknown"
    : `127.0.0.1:${settings.mixedPort}`;

  return {
    schemaVersion: CLI_STATUS_SCHEMA_VERSION,
    complete: errors.length === 0,
    healthy: core.running === false ? false : core.healthy,
    queryError: errors.length > 0 ? errors.join("; ") : null,
    autostart,
    loginStart: observation.loginStart,
    daemon,
    core,
    ...(status?.coreUpdate ? { coreUpdate: status.coreUpdate } : {}),
    ...(status?.downloadTransport
      ? {
          downloadProxy: describeDownloadTransport(status.downloadTransport),
          downloadTransport: status.downloadTransport,
        }
      : {}),
    systemProxy: {
      desired: status ? status.systemProxy.desired : settings.systemProxy,
      daemonApplied: proxy.daemonApplied,
      osObserved: proxy.osObserved,
    },
    uiInstalled: observation.uiInstalled,
    endpoints: {
      mixedProxy: mixedEndpoint,
      controller: settings.controller,
      daemonApi: `http://127.0.0.1:${daemon.port}`,
      dashboard: `http://127.0.0.1:${daemon.port}/ui/`,
    },
    activeProfile: observation.activeProfile,
    paths: {
      root: context.layout.root,
      config: context.layout.configFile,
    },
  };
}

export function cliStatusFromDaemonStatus(
  context: StatusObservationContext,
  status: DaemonStatus,
  autostart: AutostartStatus,
): CliRuntimeStatus {
  return projectRuntimeStatus(context, {
    daemon: onlineDaemonObservation(context, status),
    status,
    proxy: resolveObservedSystemProxy(status.systemProxy, null),
    autostart,
    activeProfile: status.activeProfile,
    ...readLocalStatusFacts(context, DEFAULT_STATUS_OBSERVER),
    errors: [],
  });
}

export async function collectRuntimeStatus(
  context: StatusObservationContext,
  dependencies: StatusObservationDependencies = {},
): Promise<CliRuntimeStatus> {
  const observer = statusObserver(dependencies);
  const daemonState = await observer.evaluateDaemon(context);
  let daemon = daemonObservation(context, daemonState);
  let status: DaemonStatus | undefined;
  const errors: string[] = [];
  if (daemonState.kind === "healthy") {
    try {
      status = await observer.queryDaemonStatus(context, daemonState);
      daemon = onlineDaemonObservation(context, status, daemonState);
    } catch (err) {
      status = undefined;
      daemon = { ...daemon, state: "unhealthy", healthy: false };
      addError(errors, `local API request failed: ${errorText(err)}`);
    }
  } else if (daemonState.running) {
    addError(errors, "the local API is unreachable");
  }

  const [proxy, autostart] = await Promise.all([
    observeSystemProxy(context, observer, status?.systemProxy, daemon.running ? null : false),
    observeAutostart(
      context,
      observer,
      status && daemonState.kind === "healthy" ? daemonState : undefined,
    ),
  ]);
  return projectRuntimeStatus(context, {
    daemon,
    status,
    proxy,
    autostart,
    activeProfile: status ? status.activeProfile : observer.activeProfile(context),
    ...readLocalStatusFacts(context, observer),
    errors,
  });
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

export function formatLoginStartSuffix(record: LoginStartRecord | null): string {
  if (!record || record.ok) return "";
  return " · last login start failed — run sash doctor";
}

export function markIncompleteObservation(complete: boolean): void {
  if (!complete && (process.exitCode === undefined || process.exitCode === 0)) {
    process.exitCode = 2;
  }
}
