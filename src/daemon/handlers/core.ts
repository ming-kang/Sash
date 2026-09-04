import type { CoreReloadResult, CoreStartResult } from "../../contracts.js";
import type { DaemonContext } from "../context.js";
import type { RouteResponse } from "../router.js";

export async function startCore(ctx: DaemonContext): Promise<RouteResponse> {
  const result: CoreStartResult = await ctx.startCore();
  return { status: 200, json: result };
}

export async function stopCore(ctx: DaemonContext): Promise<RouteResponse> {
  await ctx.mutate("stop core", () => ctx.lifecycle.stop());
  return { status: 204 };
}

export async function restartCore(ctx: DaemonContext): Promise<RouteResponse> {
  const result: CoreStartResult = await ctx.restartCore();
  return { status: 200, json: result };
}

export async function reloadCoreConfig(ctx: DaemonContext): Promise<RouteResponse> {
  const result = await ctx.reloadCoreConfig();
  const body: CoreReloadResult = { proxyCount: result.proxyCount, source: result.source };
  return { status: 200, json: body };
}
