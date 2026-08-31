import { openInBrowser } from "../browser.js";
import { SashDaemonClient } from "../daemon-client.js";
import { evaluateDaemon } from "../daemon-lifecycle.js";
import { log } from "../log.js";
import { runStart } from "./lifecycle.js";
import { runtimeContext } from "./shared.js";

export function dashboardUrl(daemonPort: number): string {
  return `http://127.0.0.1:${daemonPort}/ui/`;
}

export function dashboardAuthUrl(daemonPort: number, secret: string): string {
  return `http://127.0.0.1:${daemonPort}/ui/#secret=${encodeURIComponent(secret)}`;
}

/** `sash web`: make sure sash is running, then open the built-in WebUI. */
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
  }

  const port = ctx.settings.daemonPort;
  const secret = ctx.settings.daemonSecret;

  if (opts.noOpen) {
    log.ok(`dashboard: ${dashboardAuthUrl(port, secret)}`);
    log.warn("the URL above embeds the daemon secret; treat it as a credential");
    return;
  }

  log.ok(`dashboard: ${dashboardUrl(port)}`);
  openInBrowser(dashboardAuthUrl(port, secret));
}
