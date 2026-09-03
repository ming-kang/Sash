import { log } from "../log.js";
import { SettingsService } from "../settings-service.js";
import {
  type CliProxyStatus,
  collectProxyStatus,
  formatObservedProxy,
  markIncompleteObservation,
} from "../status.js";
import { SystemProxyManager } from "../system-proxy-manager.js";
import {
  createProfileService,
  type RuntimeContext,
  resolveRuntimeOwner,
  runOfflineMutation,
  runtimeContext,
} from "./shared.js";

/** `sash proxy on`: enable OS system proxy via the running sashd. */
export async function runProxyOn(): Promise<void> {
  const ctx = runtimeContext();
  const owner = await resolveRuntimeOwner(ctx);
  if (owner.kind !== "daemon") {
    throw new Error("sash is not running; start it with `sash start` before enabling system proxy");
  }

  const status = await owner.client.status();
  if (!status.core.running || !status.core.healthy) {
    throw new Error("core is not healthy; start or recover it before enabling system proxy");
  }

  await owner.client.enableProxy();
  log.ok(`system proxy enabled -> 127.0.0.1:${status.settings.mixedPort}`);
}

export async function disableProxyOffline(
  ctx: RuntimeContext,
  release: () => Promise<void> = () => new SystemProxyManager({ layout: ctx.layout }).release(),
): Promise<void> {
  const service = new SettingsService({
    layout: ctx.layout,
    getCommitted: () => ctx.settings,
    setCommitted: (next) => {
      ctx.settings = next;
    },
    setRuntime: (next) => {
      ctx.settings = next;
    },
    profiles: createProfileService(ctx),
    releaseSystemProxy: release,
    commit: async (_purpose, action) => action(),
  });
  await service.update("system-proxy", "off");
}

/** `sash proxy off`: disable OS system proxy (works even if daemon is stopped). */
export async function runProxyOff(): Promise<void> {
  const ctx = runtimeContext();
  const owner = await resolveRuntimeOwner(ctx);

  if (owner.kind === "unhealthy") {
    throw new Error("sashd is running but unresponsive; refusing a competing proxy mutation");
  }
  if (owner.kind === "daemon") {
    await owner.client.disableProxy();
  } else {
    await runOfflineMutation(ctx, "restore system proxy offline", () => disableProxyOffline(ctx));
  }
  log.ok("system proxy restored to its pre-Sash state");
}

/** `sash proxy status`: inspect desired, daemon-applied and OS-observed state. */
export type ProxyStatusCollector = () => Promise<CliProxyStatus>;

export async function runProxyStatus(
  collect: ProxyStatusCollector = () => collectProxyStatus(runtimeContext()),
): Promise<void> {
  const status = await collect();
  log.kv("daemon state", status.daemon.state);
  log.kv("desired state", status.desired ? "on" : "off");
  log.kv(
    "daemon-applied",
    status.daemonApplied === null
      ? status.daemon.state === "stopped"
        ? "n/a (stopped)"
        : "unknown"
      : status.daemonApplied
        ? "yes"
        : "no",
  );
  log.kv("os-observed", formatObservedProxy(status.osObserved));
  if (status.queryError) log.warn(`status incomplete: ${status.queryError}`);
  if (status.osObserved.supported === false) {
    log.warn(
      `system proxy unsupported on this platform: ${status.osObserved.details || "unknown"}`,
    );
  }
  markIncompleteObservation(status.complete);
}
