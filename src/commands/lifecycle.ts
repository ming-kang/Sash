import { MihomoApi } from "../api.js";
import { log } from "../log.js";
import { evaluateRunning, startDaemon, stopDaemon } from "../process.js";
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
  const state = await evaluateRunning(ctx.layout, ctx.settings);
  if (state.running) {
    log.info(`already running (pid ${state.pid})`);
    printEndpoints(ctx);
    return;
  }
  await ensureCore(ctx);
  await ensureConfig(ctx);
  if (!opts.noUi) await ensureWebUi(ctx);
  persistContext(ctx);

  const { pid } = await startDaemon({ layout: ctx.layout, settings: ctx.settings });
  log.ok(`mihomo started (pid ${pid})`);
  printEndpoints(ctx);
  if (ctx.settings.tun) {
    log.warn(
      "TUN is enabled: the core usually needs Administrator/root privileges to create the interface.",
    );
  }
}

export async function runStop(): Promise<void> {
  const ctx = runtimeContext();
  const stopped = await stopDaemon({ layout: ctx.layout });
  if (stopped) log.ok("mihomo stopped");
}

export async function runRestart(opts: StartCommandOptions = {}): Promise<void> {
  const ctx = runtimeContext();
  await stopDaemon({ layout: ctx.layout });
  await runStart(opts);
}

export function printEndpoints(ctx: RuntimeContext): void {
  const api = new MihomoApi(ctx.settings.controller, ctx.settings.secret);
  log.kv("mixed port", `127.0.0.1:${ctx.settings.mixedPort}`);
  log.kv("controller", api.baseUrl);
  if (uiInstalled(ctx.layout)) {
    log.kv("dashboard", `${api.uiUrl()}  (sash ui to open)`);
  }
}
