import { SashDaemonClient } from "../daemon-client.js";
import { evaluateDaemon } from "../daemon-lifecycle.js";
import { log } from "../log.js";
import { disableSystemProxy, getSystemProxyState } from "../sysproxy.js";
import { runtimeContext } from "./shared.js";

/** `sash proxy on`: enable OS system proxy via the running sashd. */
export async function runProxyOn(): Promise<void> {
  const ctx = runtimeContext();
  const daemonState = await evaluateDaemon(ctx.layout, ctx.settings);
  if (!daemonState.running || !daemonState.healthy) {
    throw new Error("sash is not running; start it with `sash start` before enabling system proxy");
  }

  const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
  const status = await client.status();
  if (!status.core.running) {
    throw new Error("core is not running; start it first before enabling system proxy");
  }

  await client.enableProxy();
  log.ok(`system proxy enabled -> 127.0.0.1:${ctx.settings.mixedPort}`);
}

/** `sash proxy off`: disable OS system proxy (works even if daemon is stopped). */
export async function runProxyOff(): Promise<void> {
  const ctx = runtimeContext();
  const daemonState = await evaluateDaemon(ctx.layout, ctx.settings);

  if (daemonState.running && daemonState.healthy) {
    const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
    await client.disableProxy();
  } else {
    // Daemon is down; perform direct OS cleanup
    await disableSystemProxy();
  }
  log.ok("system proxy disabled");
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
    const state = getSystemProxyState();
    log.kv("sash status", "not running");
    log.kv("os proxy state", state.enabled ? `on (${state.server || "unknown"})` : "off");
    if (!state.supported) {
      log.warn(`system proxy unsupported on this platform: ${state.details || "unknown"}`);
    }
  }
}
