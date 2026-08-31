import { MihomoApi } from "../api.js";
import { SashDaemonClient } from "../daemon-client.js";
import { ensureDaemon, evaluateDaemon, stopDaemonFromCli } from "../daemon-lifecycle.js";
import { log } from "../log.js";
import { uiInstalled } from "../webui.js";
import {
  ensureConfig,
  ensureCore,
  ensureWebUi,
  persistContext,
  type RuntimeContext,
  runtimeContext,
} from "./shared.js";

export interface StartCommandOptions {
  noUi?: boolean;
}

export async function runStart(opts: StartCommandOptions = {}): Promise<void> {
  const ctx = runtimeContext();
  await ensureCore(ctx);
  await ensureConfig(ctx);
  if (!opts.noUi) await ensureWebUi(ctx);
  persistContext(ctx);

  await ensureDaemon({ layout: ctx.layout, settings: ctx.settings });
  const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);

  const status = await client.status();
  if (status.core.running) {
    log.info(`core is already running (PID=${status.core.pid})`);
    printEndpoints(ctx);
    return;
  }

  const result = await client.startCore();
  log.ok(`core started (PID=${result.pid}${result.version ? `, version ${result.version}` : ""})`);
  printEndpoints(ctx);
  if (ctx.settings.tun) {
    log.warn(
      "TUN is enabled: the core usually needs Administrator/root privileges to create the interface.",
    );
  }
  if (ctx.settings.systemProxy) {
    log.ok("system proxy enabled");
  }
}

export async function runStop(): Promise<void> {
  const ctx = runtimeContext();
  const state = await evaluateDaemon(ctx.layout, ctx.settings);
  if (!state.running) {
    log.info("sash is not running");
    return;
  }

  const stopped = await stopDaemonFromCli({ layout: ctx.layout, settings: ctx.settings });
  if (stopped) log.ok("sash stopped (core and system proxy disabled)");
}

export async function runRestart(opts: StartCommandOptions = {}): Promise<void> {
  const ctx = runtimeContext();
  await ensureCore(ctx);
  await ensureConfig(ctx);
  if (!opts.noUi) await ensureWebUi(ctx);
  persistContext(ctx);

  await ensureDaemon({ layout: ctx.layout, settings: ctx.settings });
  const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
  const result = await client.restartCore();
  log.ok(
    `core restarted (PID=${result.pid}${result.version ? `, version ${result.version}` : ""})`,
  );
  printEndpoints(ctx);
}

export function printEndpoints(ctx: RuntimeContext): void {
  const api = new MihomoApi(ctx.settings.controller, ctx.settings.secret);
  log.kv("mixed port", `127.0.0.1:${ctx.settings.mixedPort}`);
  log.kv("controller", api.baseUrl);
  if (uiInstalled(ctx.layout)) {
    log.kv("dashboard", `${api.uiUrl()}  (sash web to open)`);
  }
}
