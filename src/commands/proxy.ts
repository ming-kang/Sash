import { SashDaemonClient } from "../daemon-client.js";
import { evaluateDaemon } from "../daemon-lifecycle.js";
import { log } from "../log.js";
import { saveSettings } from "../settings.js";
import { SystemProxyManager } from "../system-proxy-manager.js";
import { type RuntimeContext, runOfflineMutation, runtimeContext } from "./shared.js";

/** `sash proxy on`: enable OS system proxy via the running sashd. */
export async function runProxyOn(): Promise<void> {
  const ctx = runtimeContext();
  const daemonState = await evaluateDaemon(ctx.layout, ctx.settings);
  if (!daemonState.running || !daemonState.healthy) {
    throw new Error("sash is not running; start it with `sash start` before enabling system proxy");
  }

  const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
  const status = await client.status();
  if (!status.core.running || !status.core.healthy) {
    throw new Error("core is not healthy; start or recover it before enabling system proxy");
  }

  await client.enableProxy();
  log.ok(`system proxy enabled -> 127.0.0.1:${ctx.settings.mixedPort}`);
}

export async function disableProxyOffline(
  ctx: RuntimeContext,
  release: () => Promise<void> = () => new SystemProxyManager({ layout: ctx.layout }).release(),
): Promise<void> {
  ctx.settings.systemProxy = false;
  saveSettings(ctx.settings, ctx.layout);
  await release();
}

/** `sash proxy off`: disable OS system proxy (works even if daemon is stopped). */
export async function runProxyOff(): Promise<void> {
  const ctx = runtimeContext();
  const daemonState = await evaluateDaemon(ctx.layout, ctx.settings);

  if (daemonState.running) {
    if (!daemonState.healthy) {
      throw new Error("sashd is running but unresponsive; refusing a competing proxy mutation");
    }
    const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
    await client.disableProxy();
  } else {
    await runOfflineMutation(ctx, "restore system proxy offline", () => disableProxyOffline(ctx));
  }
  log.ok("system proxy restored to its pre-Sash state");
}

/** `sash proxy status`: inspect current system proxy state. */
export async function runProxyStatus(): Promise<void> {
  const ctx = runtimeContext();
  const daemonState = await evaluateDaemon(ctx.layout, ctx.settings);

  if (daemonState.running && daemonState.healthy) {
    const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
    const proxy = await client.getProxy();
    log.kv("desired state", proxy.desired ? "on" : "off");
    log.kv("applied by sash", proxy.applied ? "yes" : "no");
    log.kv("os proxy state", proxy.enabled ? `on (${proxy.server || "unknown"})` : "off");
    if (!proxy.supported) {
      log.warn(`system proxy unsupported on this platform: ${proxy.details || "unknown"}`);
    }
  } else {
    const manager = new SystemProxyManager({ layout: ctx.layout });
    const inspection = manager.inspect();
    const state = inspection.state;
    log.kv("sash status", "not running");
    log.kv("applied by sash", inspection.applied ? "yes" : "no");
    log.kv("os proxy state", state.enabled ? `on (${state.server || "unknown"})` : "off");
    if (!state.supported) {
      log.warn(`system proxy unsupported on this platform: ${state.details || "unknown"}`);
    }
  }
}
