import { openInBrowser } from "../browser.js";
import { log } from "../log.js";
import { ensureManagement } from "../runtime-owner.js";
import { writeBootstrapFile } from "../web-bootstrap.js";
import { runtimeContext } from "./shared.js";

export function dashboardUrl(port: number): string {
  return `http://127.0.0.1:${port}/ui/`;
}
export interface WebCommandDeps {
  runtimeContext?: typeof runtimeContext;
  ensureManagement?: typeof ensureManagement;
  openInBrowser?: typeof openInBrowser;
  writeBootstrap?: typeof writeBootstrapFile;
  log?: Pick<typeof log, "info" | "ok">;
}

/** Open management without starting Core. Credentials travel only through the private handoff. */
export async function runWeb(
  opts: { noOpen?: boolean } = {},
  deps: WebCommandDeps = {},
): Promise<void> {
  const ctx = (deps.runtimeContext ?? runtimeContext)();
  const owner = await (deps.ensureManagement ?? ensureManagement)(ctx);
  const url = dashboardUrl(owner.daemon.port);
  const logger = deps.log ?? log;
  if (!opts.noOpen) {
    const bootstrap = await owner.client.createWebBootstrap();
    const file = (deps.writeBootstrap ?? writeBootstrapFile)(ctx.layout, {
      dashboardUrl: url,
      ...bootstrap,
    });
    (deps.openInBrowser ?? openInBrowser)(file.fileUrl);
  } else logger.info("run 'sash web' without --no-open to authorize a browser session");
  logger.ok(`dashboard: ${url}`);
}
