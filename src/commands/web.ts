import { MihomoApi } from "../api.js";
import { openInBrowser } from "../browser.js";
import { SashDaemonClient } from "../daemon-client.js";
import { evaluateDaemon } from "../daemon-lifecycle.js";
import { log } from "../log.js";
import { uiInstalled } from "../webui.js";
import { runStart } from "./lifecycle.js";
import { ensureWebUi, persistContext, runtimeContext } from "./shared.js";

/** `sash web`: make sure the dashboard is installed and the core is up, then open it. */
export async function runWeb(opts: { noOpen?: boolean } = {}): Promise<void> {
  const ctx = runtimeContext();
  const daemonState = await evaluateDaemon(ctx.layout, ctx.settings);

  let coreRunning = false;
  if (daemonState.running && daemonState.healthy) {
    try {
      const client = new SashDaemonClient(ctx.settings.daemonPort, ctx.settings.daemonSecret);
      const status = await client.status();
      coreRunning = status.core.running;
    } catch {
      coreRunning = false;
    }
  }

  if (!coreRunning) {
    log.info("sash is not running; starting it first...");
    await runStart({});
  } else if (!uiInstalled(ctx.layout)) {
    await ensureWebUi(ctx);
    persistContext(ctx);
  }

  const api = new MihomoApi(ctx.settings.controller, ctx.settings.secret);
  if (opts.noOpen) {
    log.ok(`dashboard: ${api.dashboardAuthUrl()}`);
    log.warn("the URL above embeds the controller secret; treat it as a credential");
    return;
  }
  log.ok(`dashboard: ${api.uiUrl()}`);
  openInBrowser(api.dashboardAuthUrl());
}
