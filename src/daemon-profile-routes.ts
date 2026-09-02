import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, parseJsonObjectBody, sendError, sendJson } from "./daemon-http.js";
import {
  ProfileConflictError,
  ProfileInputError,
  ProfileNotFoundError,
  type ProfileService,
} from "./profile-service.js";

export interface ProfileRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  pathname: string;
  profiles: ProfileService;
}

function profileErrorStatus(err: unknown): number {
  if (err instanceof HttpError) return err.statusCode;
  if (err instanceof ProfileNotFoundError) return 404;
  if (err instanceof ProfileInputError) return 400;
  if (err instanceof ProfileConflictError) return 409;
  return 500;
}

/** Handle the /sash/profiles route group. */
export async function handleProfileRoutes(ctx: ProfileRouteContext): Promise<boolean> {
  const { req, res, method, pathname, profiles } = ctx;

  try {
    if (method === "GET" && pathname === "/sash/profiles") {
      sendJson(res, 200, profiles.list());
      return true;
    }

    if (method === "POST" && pathname === "/sash/profiles") {
      const body = await parseJsonObjectBody(req);
      const url = typeof body.url === "string" ? body.url.trim() : "";
      const name = typeof body.name === "string" ? body.name.trim() : undefined;
      const result = await profiles.addRemote(url, {
        ...(name ? { name } : {}),
        activate: body.activate === true,
      });
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }

    if (method === "POST" && pathname === "/sash/profiles/import") {
      const body = await parseJsonObjectBody(req, 8 * 1024 * 1024);
      const name = typeof body.name === "string" ? body.name : "imported";
      const content = typeof body.content === "string" ? body.content : "";
      const result = await profiles.importLocal(name, content);
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }

    if (method === "PUT" && pathname === "/sash/profiles/active") {
      const body = await parseJsonObjectBody(req);
      const id = body.id === null ? null : typeof body.id === "string" ? body.id : undefined;
      if (id === undefined) throw new ProfileInputError("Missing profile id string or null");
      const result = await profiles.activate(id);
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }

    if (method === "POST" && pathname === "/sash/profiles/update-all") {
      const result = await profiles.updateAll();
      sendJson(res, 200, { ok: result.failed.length === 0, ...result });
      return true;
    }

    const updateMatch = pathname.match(/^\/sash\/profiles\/([0-9]+)\/update$/);
    if (method === "POST" && updateMatch?.[1]) {
      const result = await profiles.update(updateMatch[1]);
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }

    const deleteMatch = pathname.match(/^\/sash\/profiles\/([0-9]+)$/);
    if (method === "DELETE" && deleteMatch?.[1]) {
      const result = await profiles.remove(deleteMatch[1]);
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }

    return false;
  } catch (err) {
    const status = profileErrorStatus(err);
    if (status === 500) throw err;
    sendError(res, status, (err as Error).message);
    return true;
  }
}
