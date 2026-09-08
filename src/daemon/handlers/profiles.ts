import { requiredParam } from "../../daemon-http.js";
import { ProfileInputError } from "../../profile-service.js";
import type { DaemonContext } from "../context.js";
import type { RouteRequest, RouteResponse } from "../router.js";

export function listProfiles(ctx: DaemonContext): RouteResponse {
  return { status: 200, json: ctx.profiles.list() };
}

export async function reorderProfiles(
  ctx: DaemonContext,
  req: RouteRequest,
): Promise<RouteResponse> {
  const { ids } = await req.readJson();
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string")) {
    throw new ProfileInputError("Missing profile ids array");
  }
  return { status: 200, json: await ctx.profiles.reorder(ids) };
}

export async function addProfile(ctx: DaemonContext, req: RouteRequest): Promise<RouteResponse> {
  const body = await req.readJson();
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  const result = await ctx.profiles.addRemote(url, {
    ...(name ? { name } : {}),
    activate: body.activate === true,
  });
  return { status: 200, json: result };
}

export async function importProfile(ctx: DaemonContext, req: RouteRequest): Promise<RouteResponse> {
  const body = await req.readJson(8 * 1024 * 1024);
  const name = typeof body.name === "string" ? body.name : "imported";
  const content = typeof body.content === "string" ? body.content : "";
  const result = await ctx.profiles.importLocal(name, content);
  return { status: 200, json: result };
}

export async function activateProfile(
  ctx: DaemonContext,
  req: RouteRequest,
): Promise<RouteResponse> {
  const body = await req.readJson();
  const id = body.id === null ? null : typeof body.id === "string" ? body.id : undefined;
  if (id === undefined) throw new ProfileInputError("Missing profile id string or null");
  const result = await ctx.profiles.activate(id);
  return { status: 200, json: result };
}

export async function updateAllProfiles(ctx: DaemonContext): Promise<RouteResponse> {
  // Partial failures ride in the 200 body so callers can render per-profile
  // errors without parsing an error envelope.
  const result = await ctx.profiles.updateAll();
  return { status: 200, json: result };
}

export async function updateProfile(ctx: DaemonContext, req: RouteRequest): Promise<RouteResponse> {
  const result = await ctx.profiles.update(requiredParam(req, "id"));
  return { status: 200, json: result };
}

export function readProfileContent(ctx: DaemonContext, req: RouteRequest): RouteResponse {
  return { status: 200, json: ctx.profiles.readContent(requiredParam(req, "id")) };
}

export async function writeProfileContent(
  ctx: DaemonContext,
  req: RouteRequest,
): Promise<RouteResponse> {
  const body = await req.readJson(8 * 1024 * 1024);
  const content = typeof body.content === "string" ? body.content : "";
  const revision = body.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)
    throw new ProfileInputError("A positive profile revision is required");
  const result = await ctx.profiles.writeContent(requiredParam(req, "id"), content, revision);
  return { status: 200, json: result };
}

export async function renameProfile(ctx: DaemonContext, req: RouteRequest): Promise<RouteResponse> {
  const body = await req.readJson();
  const name = typeof body.name === "string" ? body.name : "";
  const result = await ctx.profiles.rename(requiredParam(req, "id"), name);
  return { status: 200, json: result };
}

export async function removeProfile(ctx: DaemonContext, req: RouteRequest): Promise<RouteResponse> {
  const result = await ctx.profiles.remove(requiredParam(req, "id"));
  return { status: 200, json: result };
}
