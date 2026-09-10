import { HttpError } from "../../daemon-http.js";
import type { DaemonContext } from "../context.js";
import type { RouteRequest, RouteResponse } from "../router.js";

/**
 * Exchange a browser credential from an earlier daemon generation for a session
 * on this one, so a restart does not require a new `sash web` authorization.
 */
export async function continueWebSession(
  ctx: DaemonContext,
  req: RouteRequest,
): Promise<RouteResponse> {
  const body = await req.readJson(1024);
  const token = typeof body.token === "string" ? body.token : "";
  const sourceBootId = typeof body.daemonToken === "string" ? body.daemonToken : "";
  const session = ctx.webAuth.redeemContinuation(token, sourceBootId);
  if (!session)
    throw new HttpError(401, "Browser session continuation is invalid or expired; run sash web");
  return { status: 200, json: { token: session, daemonToken: ctx.token } };
}
