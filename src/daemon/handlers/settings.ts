import { parseSettingsPatch } from "../../contracts.js";
import { HttpError } from "../../daemon-http.js";
import { publicSettings } from "../../settings.js";
import type { DaemonContext } from "../context.js";
import type { RouteRequest, RouteResponse } from "../router.js";

export function readSettings(ctx: DaemonContext): RouteResponse {
  return { status: 200, json: publicSettings(ctx.settings.committed()) };
}

export async function patchSettings(ctx: DaemonContext, req: RouteRequest): Promise<RouteResponse> {
  const body = await req.readJson();
  let patch: ReturnType<typeof parseSettingsPatch>;
  try {
    patch = parseSettingsPatch(body);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
  const result = await ctx.settingsService.apply(patch);
  return {
    status: 200,
    json: {
      revision: result.revision,
      restartRequired: result.restartRequired,
      settings: publicSettings(result.settings),
    },
  };
}
