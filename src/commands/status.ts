import { currentCoreVersion } from "../core.js";
import { SashDaemonClient } from "../daemon-client.js";
import { evaluateDaemon } from "../daemon-lifecycle.js";
import { log } from "../log.js";
import { ProfileService } from "../profile-service.js";
import { SystemProxyManager } from "../system-proxy-manager.js";
import { uiInstalled } from "../webui.js";
import { runtimeContext } from "./shared.js";

export async function runStatus(opts: { json?: boolean } = {}): Promise<void> {
  const ctx = runtimeContext();
  const daemonState = await evaluateDaemon(ctx.layout, ctx.settings);
  const installedCoreVersion = currentCoreVersion(ctx.layout);
  const activeProfile = new ProfileService({
    layout: ctx.layout,
    settings: () => ctx.settings,
  }).active();

  if (opts.json) {
    let coreRunning = false;
    let corePid: number | null = null;
    let coreVersion: string | null = installedCoreVersion || null;
    let proxyApplied = false;
    let osProxy = false;

    if (daemonState.running && daemonState.healthy) {
      try {
        const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
        const status = await client.status();
        coreRunning = status.core.running;
        corePid = status.core.pid ?? null;
        if (status.core.version) coreVersion = status.core.version;
        proxyApplied = status.systemProxy.applied;
        osProxy = Boolean(status.systemProxy.actual?.enabled);
      } catch {
        // ignore
      }
    } else {
      const proxy = new SystemProxyManager({ layout: ctx.layout }).inspect();
      proxyApplied = proxy.applied;
      osProxy = proxy.state.enabled;
    }

    console.log(
      JSON.stringify(
        {
          daemon: {
            running: daemonState.running,
            pid: daemonState.pid ?? null,
            port: ctx.settings.daemonPort,
          },
          core: {
            running: coreRunning,
            pid: corePid,
            version: coreVersion,
          },
          systemProxy: {
            desired: ctx.settings.systemProxy,
            applied: proxyApplied,
            osEnabled: osProxy,
          },
          uiInstalled: uiInstalled(ctx.layout),
          mixedPort: ctx.settings.mixedPort,
          controller: ctx.settings.controller,
          daemonApi: `http://127.0.0.1:${ctx.settings.daemonPort}`,
          dashboard: `http://127.0.0.1:${ctx.settings.daemonPort}/ui/`,
          activeProfile: activeProfile
            ? { id: activeProfile.id, name: activeProfile.name, url: activeProfile.url }
            : null,
          tun: ctx.settings.tun,
          root: ctx.layout.root,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!daemonState.running) {
    log.info("sash is not running");
  } else {
    try {
      const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
      const status = await client.status();
      const coreInfo = status.core.running
        ? `core running (PID=${status.core.pid}${status.core.version ? `, ${status.core.version}` : ""})`
        : "core stopped";
      log.ok(`sashd running (PID=${daemonState.pid}), ${coreInfo}`);
    } catch {
      log.ok(`sashd running (PID=${daemonState.pid})`);
    }
  }

  log.kv("root", ctx.layout.root);
  log.kv("config", ctx.layout.configFile);
  log.kv("mixed port", `127.0.0.1:${ctx.settings.mixedPort}`);
  log.kv("system proxy", ctx.settings.systemProxy ? "enabled" : "disabled");
  log.kv("sash api", `http://127.0.0.1:${ctx.settings.daemonPort}`);
  log.kv("dashboard", `http://127.0.0.1:${ctx.settings.daemonPort}/ui/`);
  log.kv(
    "active profile",
    activeProfile ? `${activeProfile.name} (${activeProfile.url || "local file"})` : "(none)",
  );
  log.kv("tun", ctx.settings.tun ? "on" : "off");
  log.kv("core version", installedCoreVersion || "(not installed)");
}
