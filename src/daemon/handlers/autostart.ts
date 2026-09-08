import { parseAutostartEnabled } from "../../autostart-contract.js";
import { HttpError } from "../../daemon-http.js";
import { errorMessage } from "../../error-utils.js";
import type { DaemonContext } from "../context.js";
import type { RouteRequest, RouteResponse } from "../router.js";

export async function readAutostart(ctx: DaemonContext): Promise<RouteResponse> {
  return { status: 200, json: await ctx.autostart.inspect() };
}

export async function writeAutostart(
  ctx: DaemonContext,
  req: RouteRequest,
): Promise<RouteResponse> {
  const body = await req.readJson();
  let enabled: boolean;
  try {
    enabled = parseAutostartEnabled(body);
  } catch (error) {
    throw new HttpError(400, errorMessage(error));
  }
  const status = await ctx.mutate("configure login startup", () => ctx.autostart.set(enabled));
  return { status: 200, json: status };
}
