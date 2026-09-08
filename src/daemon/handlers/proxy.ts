import type { SystemProxyStatusResponse } from "../../contracts.js";
import { HttpError } from "../../daemon-http.js";
import type { DaemonContext } from "../context.js";
import type { RouteRequest, RouteResponse } from "../router.js";

export async function proxyStatus(ctx: DaemonContext, req: RouteRequest): Promise<RouteResponse> {
  const fresh = req.searchParams.get("fresh") === "1";
  if (fresh && !req.authorized)
    throw new HttpError(401, "Fresh status requires control authentication");
  const inspection = await ctx.systemProxy.inspect(fresh);
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
