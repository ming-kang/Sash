import { openInBrowser } from "../browser.js";
import { log } from "../log.js";
import { resolveRuntimeOwner } from "../runtime-owner.js";
import { runStart } from "./lifecycle.js";
import { runtimeContext } from "./shared.js";

export function dashboardUrl(daemonPort: number): string {
  return `http://127.0.0.1:${daemonPort}/ui/`;
}

/** `sash web`: make sure sash is running, then open the built-in WebUI. */
export async function runWeb(opts: { noOpen?: boolean } = {}): Promise<void> {
  const ctx = runtimeContext();
  let owner = await resolveRuntimeOwner(ctx);

  let coreRunning = false;
  if (owner.kind === "daemon") {
    try {
      coreRunning = (await owner.client.status()).core.running;
    } catch {
      coreRunning = false;
    }
  }

  if (!coreRunning) {
    log.info("sash is not running; starting it first...");
    await runStart();
    owner = await resolveRuntimeOwner(ctx);
  }
  if (owner.kind !== "daemon") {
    throw new Error("sashd did not become healthy before opening the dashboard");
  }

  const url = dashboardUrl(owner.daemon.port);
  log.ok(`dashboard: ${url}`);
  if (!opts.noOpen) openInBrowser(url);
}
