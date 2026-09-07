import { openInBrowser } from "../browser.js";
import { log } from "../log.js";
import { resolveRuntimeOwner } from "../runtime-owner.js";
import { writeBootstrapFile } from "../web-bootstrap.js";
import { runStart } from "./lifecycle.js";
import { runtimeContext } from "./shared.js";

export function dashboardUrl(daemonPort: number): string {
  return `http://127.0.0.1:${daemonPort}/ui/`;
}

export interface WebCommandDeps {
  runtimeContext?: typeof runtimeContext;
  runStart?: typeof runStart;
  resolveRuntimeOwner?: typeof resolveRuntimeOwner;
  openInBrowser?: typeof openInBrowser;
  log?: Pick<typeof log, "info" | "warn" | "ok">;
  writeBootstrap?: typeof writeBootstrapFile;
}

/**
 * `sash web`: start if needed, then authorize this browser through a
 * one-time bootstrap file. The bootstrap token never appears in logs,
 * process arguments or the printed URL.
 */
export async function runWeb(
  opts: { noOpen?: boolean } = {},
  deps: WebCommandDeps = {},
): Promise<void> {
  const logger = deps.log ?? log;
  const resolve = deps.resolveRuntimeOwner ?? resolveRuntimeOwner;
  const ctx = (deps.runtimeContext ?? runtimeContext)();
  let owner = await resolve(ctx);

  let coreRunning: boolean | null = null;
  if (owner.kind === "daemon") {
    try {
      coreRunning = (await owner.client.status()).core.running;
    } catch {
      // The responsive daemon can still serve its recovery UI. Unknown Core
      // state never authorizes a competing start.
      logger.warn("Core state is unavailable; opening the dashboard for recovery.");
    }
  }

  if (owner.kind === "offline" || coreRunning === false) {
    logger.info("sash is not running; starting it first...");
    let started = false;
    try {
      await (deps.runStart ?? runStart)();
      started = true;
    } catch (error) {
      // Startup can leave a healthy daemon serving recovery settings even when
      // Core cannot start (for example, desired TUN after service removal).
      try {
        owner = await resolve(ctx);
      } catch {
        throw error;
      }
      if (owner.kind !== "daemon") throw error;
      logger.warn(
        `Core startup failed; opening the dashboard for recovery: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (started) owner = await resolve(ctx);
  }
  if (owner.kind !== "daemon") {
    throw new Error("sashd did not become healthy before opening the dashboard");
  }

  const url = dashboardUrl(owner.daemon.port);
  if (opts.noOpen) {
    logger.ok(`dashboard: ${url}`);
    logger.info("run 'sash web' without --no-open to authorize a browser session");
    return;
  }

  const bootstrap = await owner.client.createWebBootstrap();
  const file = (deps.writeBootstrap ?? writeBootstrapFile)(ctx.layout, {
    dashboardUrl: url,
    ...bootstrap,
  });
  (deps.openInBrowser ?? openInBrowser)(file.fileUrl);
  logger.ok(`dashboard: ${url}`);
}
