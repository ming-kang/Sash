import type { AutostartStatus } from "./autostart/contract.js";
import { coreUpdateProgressText } from "./core-update.js";
import { log } from "./log.js";
import { readSashPackageInfo } from "./package-info.js";
import type { CliObservedSystemProxy, CliRuntimeStatus } from "./status.js";

export function autoStartValue(status: AutostartStatus): string {
  const labels = {
    on: "On",
    off: "Off",
    stale: "Needs Repair",
    disabled: "Off (Disabled in Windows)",
    unknown: "Unknown",
    unsupported: "Not Supported",
  };
  return labels[status.state];
}

export function printAutoStartWarnings(status: AutostartStatus): void {
  if (status.reason) log.warn(status.reason);
  if (status.state === "stale" || status.state === "disabled") {
    if (status.canEnable) log.info("Run sash auto on to repair the start-at-login entry.");
  } else if (status.state === "unknown" && !status.reason)
    log.warn("Could not read the Windows start-at-login setting.");
}

export function systemProxyValue(observed: CliObservedSystemProxy): string {
  return observed.supported === false
    ? "Not Supported"
    : observed.enabled === null
      ? "Unknown"
      : observed.enabled
        ? "On"
        : "Off";
}

export function printSystemProxyWarnings(desired: boolean, observed: CliObservedSystemProxy): void {
  if (observed.supported === false) return;
  if (observed.enabled === null) {
    log.warn(observed.details ?? "Could not read the Windows system proxy setting.");
  } else if (desired !== observed.enabled) {
    log.warn(
      `Windows system proxy is ${observed.enabled ? "On" : "Off"}, but Sash is configured ${desired ? "On" : "Off"}.`,
    );
    log.info(desired ? "Run sash proxy on to apply it." : "Run sash proxy status for details.");
  }
}

export function printStatus(status: CliRuntimeStatus, verbose = false): void {
  const { daemon, core } = status;
  let headline: string;
  if (daemon.state === "stopped") headline = "Sash & Core Stopped";
  else if (daemon.state === "unhealthy") headline = "Sash Unresponsive · Core Unknown";
  else if (core.running === null) headline = "Sash Running · Core Unknown";
  else if (!core.running)
    headline = `Sash Running · Core ${core.installedVersion ? "Stopped" : "Not Installed"}`;
  else
    headline =
      core.healthy === true
        ? "Sash & Core Running"
        : core.healthy === null
          ? "Sash Running · Core Health Unknown"
          : "Sash Running · Core Unhealthy";
  const proxyPort =
    core.running === null
      ? "Unknown"
      : !core.running
        ? "Off"
        : core.healthy === null
          ? "Unknown"
          : core.healthy !== true
            ? "Unavailable"
            : status.endpoints.mixedProxy === "unknown"
              ? "Unknown"
              : status.endpoints.mixedProxy;
  const web = !status.uiInstalled
    ? "Not Installed"
    : daemon.state === "stopped"
      ? "Off"
      : daemon.state !== "healthy"
        ? "Unknown"
        : new URL(status.endpoints.dashboard).host;
  log.table([
    ["Status", headline],
    ["Proxy Port", proxyPort],
    ["System Proxy", systemProxyValue(status.systemProxy.osObserved)],
    ["WebUI", web],
    ["Auto Start", autoStartValue(status.autostart)],
    ["Data Folder", status.paths.root],
  ]);
  const installed = readSashPackageInfo().version;
  if (verbose) {
    const transport = status.downloadTransport;
    log.info("");
    log.table([
      ["Profile", status.activeProfile?.name ?? "Built-in"],
      [
        "Source",
        status.activeProfile
          ? status.activeProfile.url
            ? "Subscription"
            : "Local File"
          : "Built-in",
      ],
      ["Sash Version", daemon.version ?? installed],
      ["Core Version", core.version ?? core.installedVersion ?? "Not Installed"],
      [
        "Download Via",
        transport
          ? `${transport.source === "core" ? "Core" : "Environment"} Proxy · ${transport.uri}`
          : daemon.state === "healthy"
            ? "Direct"
            : daemon.state === "stopped"
              ? "None (Sash Stopped)"
              : "Unknown (Sash Unresponsive)",
      ],
      ["Local API", status.endpoints.daemonApi],
      ["Core Config", status.paths.config],
      ...(core.running !== true || core.healthy !== true
        ? [["Proxy Address", status.endpoints.mixedProxy]]
        : []),
    ]);
  }
  if (status.coreUpdate) log.kv("Core Update", coreUpdateProgressText(status.coreUpdate));
  if (status.delay) {
    const delay = status.delay;
    const labels = {
      pending: "Testing",
      ok: "OK",
      timeout: "Timed Out",
      failed: "Failed",
      not_found: "Not Found",
      unavailable: "Unavailable",
    };
    log.kv(
      "Latency",
      `${delay.name} · ${delay.state === "ok" ? `${delay.delayMs} ms` : labels[delay.state]}`,
    );
    if (delay.error) log.warn(delay.error);
  }
  if (status.queryError) log.warn(status.queryError);
  if (daemon.state === "unhealthy") log.info("Run sash logs --daemon --errors, then sash doctor.");
  else if (core.running && core.healthy !== true)
    log.info("Run sash logs --errors, then sash doctor.");
  printSystemProxyWarnings(status.systemProxy.desired, status.systemProxy.osObserved);
  printAutoStartWarnings(status.autostart);
  if (status.loginStart && !status.loginStart.ok) {
    log.warn("The last login start failed.");
    log.info("Run sash logs --startup for details.");
  }
  if (!status.uiInstalled)
    log.warn("WebUI files are missing. Reinstall Sash, or run npm run build in a source checkout.");
  if (daemon.version && daemon.version !== installed) {
    log.warn(`Sash ${daemon.version} is running; ${installed} is installed.`);
    log.info("Run sash stop, then sash start to load the installed version.");
  }
}
