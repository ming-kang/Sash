import type { TunStatusResponse } from "../contracts.js";
import type { DaemonContext } from "./context.js";

/**
 * Shared computation for the TUN status surface — the HTTP handler and the
 * daemon event feed must report the same desired/applied pair. `fresh`
 * forces a new helper inspection; the event feed uses the cached inspection
 * so its 5s sampling does not shell out every tick.
 */
export function currentTunStatus(ctx: DaemonContext, fresh = false): Promise<TunStatusResponse> {
  const applied = ctx.supervisor.isRunning()
    ? ctx.lifecycle.configuration()?.settings.tun
    : undefined;
  return ctx.tun.status(ctx.settings.committed().tun.enable, applied, { fresh });
}
