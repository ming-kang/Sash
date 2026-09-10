import type { SettingsPatch } from "../../contracts.js";
import { HttpError } from "../../daemon-http.js";
import { isPlainObject } from "../../json-shape.js";
import { publicSettings } from "../../settings.js";
import type { DaemonContext } from "../context.js";
import type { RouteRequest, RouteResponse } from "../router.js";

const PATCHABLE_KEYS = ["expectedRevision", "mixedPort", "allowLan", "systemProxy"];

/** Selects the patchable fields; the settings service validates their values. */
function readSettingsPatch(body: unknown): SettingsPatch {
  const source = isPlainObject(body) ? body : {};
  for (const key of Object.keys(source)) {
    if (!PATCHABLE_KEYS.includes(key)) throw new HttpError(400, `Unknown settings field: ${key}`);
  }
  return source as SettingsPatch;
}

export function readSettings(ctx: DaemonContext): RouteResponse {
  return { status: 200, json: publicSettings(ctx.settings.committed()) };
}

export async function patchSettings(ctx: DaemonContext, req: RouteRequest): Promise<RouteResponse> {
  const result = await ctx.settingsService.apply(readSettingsPatch(await req.readJson()));
  return {
    status: 200,
    json: {
      revision: result.revision,
      restartRequired: result.restartRequired,
      settings: publicSettings(result.settings),
    },
  };
}
