import { MihomoApi } from "../../api.js";
import { validateCoreReleaseTag } from "../../core-install-record.js";
import { HttpError } from "../../daemon-http.js";
import type { DaemonContext } from "../context.js";
import type { RouteRequest, RouteResponse } from "../router.js";

export async function startCore(ctx: DaemonContext): Promise<RouteResponse> {
  return { status: 200, json: await ctx.startCore() };
}
export async function stopCore(ctx: DaemonContext): Promise<RouteResponse> {
  await ctx.stopCore();
  return { status: 204 };
}
export async function restartCore(ctx: DaemonContext): Promise<RouteResponse> {
  return { status: 200, json: await ctx.restartCore() };
}
export async function updateCore(ctx: DaemonContext, req: RouteRequest): Promise<RouteResponse> {
  const body = await req.readJson(1024);
  if (
    Object.keys(body).some((key) => key !== "version") ||
    (body.version !== undefined && typeof body.version !== "string")
  ) {
    throw new HttpError(400, "Expected an optional Core version string");
  }
  let version: string | undefined;
  try {
    version = typeof body.version === "string" ? validateCoreReleaseTag(body.version) : undefined;
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
  return { status: 200, json: await ctx.updateCore(version) };
}

export async function setCoreMode(ctx: DaemonContext, req: RouteRequest): Promise<RouteResponse> {
  const body = await req.readJson(1024);
  const mode = body.mode;
  if (
    Object.keys(body).some((key) => key !== "mode") ||
    (mode !== "rule" && mode !== "global" && mode !== "direct")
  )
    throw new HttpError(400, "Invalid routing mode");
  await ctx.gate.runLiveMutation(async () => {
    const owner = ctx.supervisor.ownedCoreSnapshot();
    if (!owner) throw new HttpError(409, "A running owned Core is required to change routing mode");
    const settings = ctx.settings.runtime();
    await new MihomoApi(settings.controller, settings.secret).setMode(mode);
    if (!ctx.supervisor.ownsCore(owner))
      throw new HttpError(409, "Core changed during the mode request; inspect its current mode");
  });
  return { status: 204 };
}
