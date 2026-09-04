import type { SystemProxyStatusResponse } from "../../contracts.js";
import type { DaemonContext } from "../context.js";
import type { RouteRequest, RouteResponse } from "../router.js";

export async function proxyStatus(ctx: DaemonContext, req: RouteRequest): Promise<RouteResponse> {
  const inspection = await ctx.systemProxy.inspect(req.searchParams.get("fresh") === "1");
  const body: SystemProxyStatusResponse = {
    desired: ctx.settings.committed().systemProxy,
    applied: inspection.applied,
    ...inspection.state,
    appliedKnown: inspection.appliedKnown,
    stateKnown: inspection.stateKnown,
    ...(inspection.queryError ? { queryError: inspection.queryError } : {}),
  };
  return { status: 200, json: body };
}
