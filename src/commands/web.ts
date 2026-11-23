import { tryOpenInBrowser } from "../browser.js";
import { ensureDaemonSession } from "../daemon-session.js";
import { log } from "../log.js";
import { runtimeContext } from "./shared.js";

export function dashboardUrl(port: number): string {
  return `http://127.0.0.1:${port}/ui/`;
}
export interface WebCommandDeps {
  runtimeContext?: typeof runtimeContext;
  ensureDaemonSession?: typeof ensureDaemonSession;
  openInBrowser?: typeof tryOpenInBrowser;
  log?: Pick<typeof log, "info" | "ok">;
}

export async function runWeb(
  opts: { noOpen?: boolean } = {},
  deps: WebCommandDeps = {},
): Promise<void> {
  const ctx = (deps.runtimeContext ?? runtimeContext)();
  const owner = await (deps.ensureDaemonSession ?? ensureDaemonSession)(ctx);
  const url = dashboardUrl(owner.daemon.port);
  const logger = deps.log ?? log;
  if (!opts.noOpen) {
    (deps.openInBrowser ?? tryOpenInBrowser)(url);
    logger.info("Opening WebUI");
  }
  logger.ok(url);
}
