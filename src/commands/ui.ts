import { MihomoApi } from "../api.js";
import { openInBrowser } from "../browser.js";
import { log } from "../log.js";
import { evaluateRunning } from "../process.js";
import { uiInstalled } from "../webui.js";
import { runStart } from "./lifecycle.js";
import { ensureWebUi, persistContext, runtimeContext } from "./shared.js";

/** `sash ui`: make sure the dashboard is installed and the core is up, then open it. */
export async function runUi(opts: { noOpen?: boolean } = {}): Promise<void> {
  const ctx = runtimeContext();

  const state = await evaluateRunning(ctx.layout, ctx.settings);
  if (!state.running) {
    log.info("core is not running; starting it first...");
    await runStart({});
  } else if (!uiInstalled(ctx.layout)) {
    await ensureWebUi(ctx);
    persistContext(ctx);
  }

  const api = new MihomoApi(ctx.settings.controller, ctx.settings.secret);
  if (opts.noOpen) {
    // Asked for an address to copy, so it has to carry the credential.
    log.ok(`dashboard: ${api.dashboardAuthUrl()}`);
    log.warn("the URL above embeds the controller secret; treat it as a credential");
    return;
  }
  log.ok(`dashboard: ${api.uiUrl()}`);
  openInBrowser(api.dashboardAuthUrl());
}
