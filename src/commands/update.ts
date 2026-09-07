import { type CoreUpdateServiceDeps, runCoreUpdate } from "../core-update-service.js";
import { runtimeContext } from "./shared.js";

/** `sash update` upgrades the managed Core binary with rollback. */
export async function runUpdate(
  opts: { version?: string; force?: boolean } = {},
  deps: CoreUpdateServiceDeps = {},
): Promise<void> {
  await runCoreUpdate(runtimeContext(), opts, deps);
}
