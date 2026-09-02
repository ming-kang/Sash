import { log } from "../log.js";
import {
  type CliRuntimeStatus,
  collectRuntimeStatus,
  formatObservedProxy,
  formatTunObservation,
  markIncompleteObservation,
  runtimeStatusHeadline,
  shouldShowTunGuidance,
} from "../status.js";
import { tunPrivilegeGuidance } from "../tun-guidance.js";
import { runtimeContext } from "./shared.js";

export type RuntimeStatusCollector = () => Promise<CliRuntimeStatus>;

export async function runStatus(
  opts: { json?: boolean } = {},
  collect: RuntimeStatusCollector = () => collectRuntimeStatus(runtimeContext()),
): Promise<void> {
  const status = await collect();

  if (opts.json) {
    console.log(JSON.stringify(status, null, 2));
    markIncompleteObservation(status.complete);
    return;
  }

  const headline = runtimeStatusHeadline(status);
  log[headline.level](headline.text);
  if (status.queryError) log.warn(`status incomplete: ${status.queryError}`);

  log.kv("root", status.paths.root);
  log.kv("config", status.paths.config);
  log.kv("mixed port", status.endpoints.mixedProxy);
  log.kv("proxy desired", status.systemProxy.desired ? "on" : "off");
  log.kv(
    "daemon applied",
    status.systemProxy.daemonApplied === null
      ? status.daemon.state === "stopped"
        ? "n/a (stopped)"
        : "unknown"
      : status.systemProxy.daemonApplied
        ? "yes"
        : "no",
  );
  log.kv("os proxy", formatObservedProxy(status.systemProxy.osObserved));
  log.kv("sash api", status.endpoints.daemonApi);
  log.kv("dashboard", status.endpoints.dashboard);
  log.kv(
    "active profile",
    status.activeProfile
      ? `${status.activeProfile.name} (${status.activeProfile.url || "local file"})`
      : "(none)",
  );
  log.kv("tun", formatTunObservation(status));
  log.kv("core version", status.core.installedVersion || "(not installed)");
  if (shouldShowTunGuidance(status)) {
    log.warn(tunPrivilegeGuidance("runtime-inactive", { root: status.paths.root }));
  }
  markIncompleteObservation(status.complete);
}
