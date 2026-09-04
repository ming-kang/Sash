import fs from "node:fs";
import {
  parseSettingsPatch,
  type SettingsPatch,
  type SettingsWriteResult,
} from "../../contracts.js";
import { HttpError } from "../../daemon-http.js";
import { parseSettingsText, publicSettings } from "../../settings.js";
import type { SettingsApplyResult } from "../../settings-service.js";
import type { DaemonContext } from "../context.js";
import type { RouteRequest, RouteResponse } from "../router.js";

function writeResultBody(result: SettingsApplyResult): SettingsWriteResult {
  return {
    restartRequired: result.restartRequired,
    settings: publicSettings(result.settings),
  };
}

export function readSettings(ctx: DaemonContext): RouteResponse {
  return { status: 200, json: publicSettings(ctx.settings.committed()) };
}

export async function patchSettings(ctx: DaemonContext, req: RouteRequest): Promise<RouteResponse> {
  const body = await req.readJson();
  let patch: SettingsPatch;
  try {
    patch = parseSettingsPatch(body, "request");
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  const result = await ctx.settingsService.apply(patch);
  return { status: 200, json: writeResultBody(result) };
}

export function readSettingsFile(ctx: DaemonContext): RouteResponse {
  let content: string;
  try {
    content = fs.readFileSync(ctx.layout.settingsFile, "utf8");
  } catch {
    throw new HttpError(404, "Settings file does not exist yet");
  }
  return { status: 200, json: { content } };
}

export async function writeSettingsFile(
  ctx: DaemonContext,
  req: RouteRequest,
): Promise<RouteResponse> {
  const body = await req.readJson(256 * 1024);
  const content = typeof body.content === "string" ? body.content : "";
  let parsed: ReturnType<typeof parseSettingsText>;
  try {
    parsed = parseSettingsText(content, ctx.layout.settingsFile);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  const result = await ctx.settingsService.applyFileSettings(parsed);
  // daemonSecret is read from memory on every authenticated request, so it
  // hot-swaps. daemonPort only lands on disk: the listener cannot be rebound
  // online, and the next `sash restart` picks it up.
  return { status: 200, json: writeResultBody(result) };
}
