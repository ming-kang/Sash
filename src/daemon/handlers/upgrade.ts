import { HttpError } from "../../daemon-http.js";
import { parseUpgradeAccess } from "../../upgrade-access.js";
import type { DaemonContext } from "../context.js";
import type { RouteRequest, RouteResponse } from "../router.js";

export async function upgradeAction(ctx: DaemonContext, req: RouteRequest): Promise<RouteResponse> {
  const body = await req.readJson(2048);
  let access: ReturnType<typeof parseUpgradeAccess>;
  try {
    access = parseUpgradeAccess(body);
  } catch {
    throw new HttpError(400, "Invalid Sash upgrade request");
  }
  switch (req.params.action) {
    case "reserve":
      return { status: 200, json: await ctx.upgrade.reserve(access) };
    case "status":
      return { status: 200, json: ctx.upgrade.status(access) };
    case "verify":
      return { status: 200, json: await ctx.upgrade.verify(access) };
    case "commit":
      return { status: 200, json: await ctx.upgrade.commit(access) };
    case "release":
      await ctx.upgrade.release(access);
      return { status: 204 };
    case "cleanup":
      await ctx.upgrade.cleanup(access);
      return { status: 204 };
    case "stop":
      await ctx.upgrade.stop(access);
      return {
        status: 204,
        after: () => {
          void ctx
            .closeListener()
            .then(() => ctx.onShutdown?.())
            .catch(() => undefined);
        },
      };
    default:
      throw new HttpError(404, "Unknown Sash upgrade action");
  }
}

export async function continueWebSession(
  ctx: DaemonContext,
  req: RouteRequest,
): Promise<RouteResponse> {
  const body = await req.readJson(1024);
  if (
    Object.keys(body).some((key) => key !== "token" && key !== "daemonToken") ||
    typeof body.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(body.token) ||
    typeof body.daemonToken !== "string" ||
    !/^[a-f0-9]{48}$/.test(body.daemonToken)
  )
    throw new HttpError(400, "Invalid browser upgrade continuation");
  return { status: 200, json: await ctx.upgrade.continueWebSession(body.token, body.daemonToken) };
}
