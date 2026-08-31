import { MihomoApi } from "../api.js";
import { log } from "../log.js";
import { evaluateRunning } from "../process.js";
import { uiInstalled } from "../webui.js";
import { runtimeContext } from "./shared.js";

export async function runStatus(opts: { json?: boolean } = {}): Promise<void> {
  const ctx = runtimeContext();
  const state = await evaluateRunning(ctx.layout, ctx.settings);
  const api = new MihomoApi(ctx.settings.controller, ctx.settings.secret);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          running: state.running,
          pid: state.pid ?? null,
          coreVersion: state.version ?? (ctx.settings.coreVersion || null),
          uiVersion: ctx.settings.uiVersion || null,
          uiInstalled: uiInstalled(ctx.layout),
          mixedPort: ctx.settings.mixedPort,
          controller: api.baseUrl,
          dashboard: uiInstalled(ctx.layout) ? api.uiUrl() : null,
          subscription: ctx.settings.subscriptionUrl || null,
          tun: ctx.settings.tun,
          root: ctx.layout.root,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!state.running) {
    log.info("mihomo is not running");
    if (state.stalePidFile) log.warn("a stale pid file was found and ignored");
  } else {
    log.ok(`mihomo running (pid ${state.pid}${state.version ? `, core ${state.version}` : ""})`);
    if (!state.healthy) log.warn("external-controller is not responding yet");
  }
  log.kv("root", ctx.layout.root);
  log.kv("config", ctx.layout.configFile);
  log.kv("mixed port", `127.0.0.1:${ctx.settings.mixedPort}`);
  log.kv("controller", api.baseUrl);
  log.kv("dashboard", uiInstalled(ctx.layout) ? api.uiUrl() : "(not installed)");
  log.kv("subscription", ctx.settings.subscriptionUrl || "(none)");
  log.kv("tun", ctx.settings.tun ? "on" : "off");
  log.kv("core version", ctx.settings.coreVersion || "(not installed)");
  log.kv("ui version", ctx.settings.uiVersion || "(not installed)");
}
