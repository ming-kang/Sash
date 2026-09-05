import { type CoreUpdateServiceDeps, runCoreUpdate } from "../core-update-service.js";
import { serviceStatus, updateServiceCore } from "../service-management.js";
import { runtimeContext } from "./shared.js";

export interface UpdateCommandDeps extends CoreUpdateServiceDeps {
  platform?: NodeJS.Platform;
  serviceStatus?: typeof serviceStatus;
  updateServiceCore?: typeof updateServiceCore;
  runCoreUpdate?: typeof runCoreUpdate;
}

/** `sash update` upgrades the managed Core binary with rollback. */
export async function runUpdate(
  opts: { version?: string; force?: boolean } = {},
  deps: UpdateCommandDeps = {},
): Promise<void> {
  const ctx = runtimeContext();
  if ((deps.platform ?? process.platform) === "win32") {
    const service = await (deps.serviceStatus ?? serviceStatus)(ctx.layout);
    if (service.state === "ready") {
      await (deps.updateServiceCore ?? updateServiceCore)(ctx, {
        ...(opts.version !== undefined ? { version: opts.version } : {}),
      });
      return;
    }
    if (service.state !== "not-installed" || !service.supported) {
      throw new Error(
        service.message ??
          `Service is ${service.state}; refusing a direct Core update. Inspect sash service status and repair the service from Administrator PowerShell.`,
      );
    }
  }
  await (deps.runCoreUpdate ?? runCoreUpdate)(ctx, opts, deps);
}
