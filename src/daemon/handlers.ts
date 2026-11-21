import {
  coreDelayBodySchema,
  coreModeBodySchema,
  coreUpdateBodySchema,
  profileActivateBodySchema,
  profileAddBodySchema,
  profileContentBodySchema,
  profileImportBodySchema,
  profileRenameBodySchema,
  profilesReorderBodySchema,
  settingsPatchBodySchema,
} from "../api-schemas.js";
import { parseAutostartEnabled } from "../autostart/contract.js";
import type {
  HealthInfo,
  SettingsPatch,
  SystemProxyStatusResponse,
  WebBootstrapInfo,
  WebSessionInfo,
} from "../contracts.js";
import { validateCoreReleaseTag } from "../core.js";
import { validateDelayTarget } from "../core-delay.js";
import { errorMessage } from "../error-utils.js";
import { ProfileInputError } from "../profile-service.js";
import { publicSettings } from "../settings.js";
import type { DaemonContext } from "./context.js";
import { HttpError } from "./http.js";
import type { DaemonRequest, RouteDef, RouteResponse } from "./router.js";
import { readDaemonStatus } from "./status.js";

const JSON_KB = 1024;
const PROFILE_BODY_LIMIT = 8 * 1024 * 1024;

export function sashApiRoutes(): readonly RouteDef[] {
  return [
    {
      methods: ["GET"],
      path: "/sash/daemon/health",
      auth: "public",
      handler: health,
    },
    {
      methods: ["GET"],
      path: "/sash/daemon/status",
      auth: "public",
      handler: daemonStatus,
    },
    {
      methods: ["POST"],
      path: "/sash/daemon/shutdown",
      auth: "control",
      handler: shutdownDaemon,
    },
    {
      methods: ["POST"],
      path: "/sash/web/bootstrap",
      auth: "control",
      handler: createWebBootstrap,
    },
    // The bootstrap exchange itself is public: the one-time token in the
    // request body is the credential being redeemed.
    {
      methods: ["POST"],
      path: "/sash/web/session",
      auth: "public",
      bodyLimit: JSON_KB,
      handler: redeemWebBootstrap,
    },
    {
      methods: ["POST"],
      path: "/sash/core/start",
      auth: "control",
      handler: startCore,
    },
    {
      methods: ["PUT"],
      path: "/sash/core/mode",
      auth: "control",
      bodyLimit: JSON_KB,
      handler: setCoreMode,
    },
    {
      methods: ["POST"],
      path: "/sash/core/delay",
      auth: "control",
      bodyLimit: 4096,
      handler: testCoreDelay,
    },
    {
      methods: ["POST"],
      path: "/sash/core/stop",
      auth: "control",
      handler: stopCore,
    },
    {
      methods: ["POST"],
      path: "/sash/core/restart",
      auth: "control",
      handler: restartCore,
    },
    {
      methods: ["POST"],
      path: "/sash/core/update",
      auth: "control",
      bodyLimit: JSON_KB,
      handler: updateCore,
    },
    {
      methods: ["GET"],
      path: "/sash/core/update",
      auth: "control",
      handler: coreUpdateProgress,
    },
    {
      methods: ["DELETE"],
      path: "/sash/core/update",
      auth: "control",
      handler: cancelCoreUpdate,
    },
    { methods: ["GET"], path: "/sash/proxy", auth: "public", handler: proxyStatus },
    {
      methods: ["GET"],
      path: "/sash/autostart",
      auth: "control",
      handler: readAutostart,
    },
    {
      methods: ["PUT"],
      path: "/sash/autostart",
      auth: "control",
      handler: writeAutostart,
    },
    {
      methods: ["GET"],
      path: "/sash/settings",
      auth: "control",
      handler: readSettings,
    },
    {
      methods: ["PATCH"],
      path: "/sash/settings",
      auth: "control",
      handler: patchSettings,
    },
    {
      methods: ["GET"],
      path: "/sash/profiles",
      auth: "control",
      handler: listProfiles,
    },
    {
      methods: ["POST"],
      path: "/sash/profiles",
      auth: "control",
      handler: addProfile,
    },
    {
      methods: ["PUT"],
      path: "/sash/profiles/order",
      auth: "control",
      handler: reorderProfiles,
    },
    {
      methods: ["POST"],
      path: "/sash/profiles/import",
      auth: "control",
      bodyLimit: PROFILE_BODY_LIMIT,
      handler: importProfile,
    },
    {
      methods: ["POST"],
      path: "/sash/profiles/update-all",
      auth: "control",
      handler: updateAllProfiles,
    },
    {
      methods: ["PUT"],
      path: "/sash/profiles/active",
      auth: "control",
      handler: activateProfile,
    },
    {
      methods: ["POST"],
      path: "/sash/profiles/:id([0-9]+)/update",
      auth: "control",
      handler: updateProfile,
    },
    {
      methods: ["GET"],
      path: "/sash/profiles/:id([0-9]+)/content",
      auth: "control",
      handler: readProfileContent,
    },
    {
      methods: ["PUT"],
      path: "/sash/profiles/:id([0-9]+)/content",
      auth: "control",
      bodyLimit: PROFILE_BODY_LIMIT,
      handler: writeProfileContent,
    },
    {
      methods: ["PATCH"],
      path: "/sash/profiles/:id([0-9]+)",
      auth: "control",
      handler: renameProfile,
    },
    {
      methods: ["DELETE"],
      path: "/sash/profiles/:id([0-9]+)",
      auth: "control",
      handler: removeProfile,
    },
  ];
}

function requiredParam(req: DaemonRequest, name: string): string {
  const value = req.params[name];
  if (value === undefined) throw new Error(`Missing route parameter: ${name}`);
  return value;
}

export async function readAutostart(ctx: DaemonContext): Promise<RouteResponse> {
  return { status: 200, json: await ctx.autostart.inspect() };
}

export async function writeAutostart(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<RouteResponse> {
  const body = await req.readJson();
  let enabled: boolean;
  try {
    enabled = parseAutostartEnabled(body);
  } catch (error) {
    throw new HttpError(400, errorMessage(error));
  }
  const status = await ctx.mutate(() => ctx.autostart.set(enabled));
  return { status: 200, json: status };
}

export async function startCore(ctx: DaemonContext): Promise<RouteResponse> {
  return { status: 200, json: await ctx.core.start() };
}
export async function stopCore(ctx: DaemonContext): Promise<RouteResponse> {
  await ctx.core.stop();
  return { status: 204 };
}
export async function restartCore(ctx: DaemonContext): Promise<RouteResponse> {
  return { status: 200, json: await ctx.core.apply() };
}
export function coreUpdateProgress(ctx: DaemonContext): RouteResponse {
  return { status: 200, json: ctx.core.progress };
}
export async function cancelCoreUpdate(ctx: DaemonContext): Promise<RouteResponse> {
  ctx.core.cancel();
  return { status: 204 };
}
export async function updateCore(ctx: DaemonContext, req: DaemonRequest): Promise<RouteResponse> {
  const body = coreUpdateBodySchema.safeParse(await req.readJson());
  if (!body.success) throw new HttpError(400, "Expected an optional Core version string");
  let version: string | undefined;
  try {
    version =
      body.data.version !== undefined ? validateCoreReleaseTag(body.data.version) : undefined;
  } catch (error) {
    throw new HttpError(400, errorMessage(error));
  }
  return { status: 200, json: await ctx.core.update(version) };
}

export async function setCoreMode(ctx: DaemonContext, req: DaemonRequest): Promise<RouteResponse> {
  const body = coreModeBodySchema.safeParse(await req.readJson());
  if (!body.success) throw new HttpError(400, "Invalid routing mode");
  await ctx.gate.runLiveMutation(async () => {
    const owner = ctx.supervisor.ownedCoreSnapshot();
    if (!owner) throw new HttpError(409, "A running owned Core is required to change routing mode");
    const settings = ctx.settings.runtime();
    await ctx.engine.api(settings.controller, settings.secret).setMode(body.data.mode);
    if (!ctx.supervisor.ownsCore(owner))
      throw new HttpError(409, "Core changed during the mode request; inspect its current mode");
  });
  return { status: 204 };
}

export async function testCoreDelay(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<RouteResponse> {
  const body = coreDelayBodySchema.safeParse(await req.readJson());
  let name: string;
  try {
    if (!body.success) throw new TypeError("Expected only a node or group name");
    name = validateDelayTarget(body.data.name);
  } catch (error) {
    throw new HttpError(400, errorMessage(error));
  }
  const result = await ctx.gate.runLiveMutation(async () => {
    req.signal.throwIfAborted();
    const owner = ctx.supervisor.ownedCoreSnapshot();
    if (!owner) throw new HttpError(409, "A running owned Core is required for a delay test");
    const settings = ctx.settings.runtime();
    const result = await ctx.engine
      .api(settings.controller, settings.secret)
      .delay(name, req.signal);
    if (!ctx.supervisor.ownsCore(owner))
      throw new HttpError(409, "Core changed during the delay test; try again");
    return result;
  });
  return { status: 200, json: result };
}

export function health(ctx: DaemonContext): RouteResponse {
  // The token is a per-boot identity nonce for daemon instance matching. It
  // is deliberately not a credential: control requests require the CLI
  // bearer or a WebUI session token from the bootstrap exchange below.
  const body: HealthInfo = {
    token: ctx.token,
    pid: process.pid,
    startedAt: ctx.startedAt,
    version: ctx.version,
  };
  return { status: 200, json: body };
}

export function createWebBootstrap(ctx: DaemonContext): RouteResponse {
  const bootstrap = ctx.webAuth.createBootstrap();
  const body: WebBootstrapInfo = { token: bootstrap.token, expiresAt: bootstrap.expiresAt };
  return { status: 200, json: body };
}

export async function redeemWebBootstrap(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<RouteResponse> {
  const body = await req.readJson();
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const session = ctx.webAuth.redeemBootstrap(token);
  if (!session) throw new HttpError(401, "Invalid or expired bootstrap token");
  const response: WebSessionInfo = { token: session, daemonToken: ctx.token };
  return { status: 200, json: response };
}

export async function daemonStatus(ctx: DaemonContext, req: DaemonRequest): Promise<RouteResponse> {
  const fresh = req.searchParams.get("fresh") === "1";
  if (fresh && !req.authorized)
    throw new HttpError(401, "Fresh status requires control authentication");
  const status = await readDaemonStatus(ctx, fresh);
  if (!req.authorized) {
    if (status.activeProfile) status.activeProfile.url = "";
    if (status.configuration.appliedProfile) status.configuration.appliedProfile.url = "";
  }
  return { status: 200, json: status };
}

export function shutdownDaemon(ctx: DaemonContext): Promise<RouteResponse> {
  return ctx.shutdown().then(() => ({
    status: 204,
    // The listener closes only after this response has finished streaming:
    // server.close() waits for the in-flight shutdown request itself.
    after: () => {
      void ctx
        .closeListener()
        .then(() => ctx.onShutdown?.())
        .catch(() => undefined);
    },
  }));
}

export function listProfiles(ctx: DaemonContext): RouteResponse {
  return { status: 200, json: ctx.profiles.list() };
}

export async function reorderProfiles(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<RouteResponse> {
  const body = profilesReorderBodySchema.safeParse(await req.readJson());
  if (!body.success) throw new ProfileInputError("Missing profile ids array");
  return { status: 200, json: await ctx.profiles.reorder(body.data.ids) };
}

export async function addProfile(ctx: DaemonContext, req: DaemonRequest): Promise<RouteResponse> {
  const body = profileAddBodySchema.safeParse(await req.readJson());
  const data = body.success ? body.data : {};
  const url = typeof data.url === "string" ? data.url.trim() : "";
  const name = typeof data.name === "string" ? data.name.trim() : undefined;
  const result = await ctx.profiles.addRemote(url, {
    ...(name ? { name } : {}),
    activate: data.activate === true,
  });
  return { status: 200, json: result };
}

export async function importProfile(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<RouteResponse> {
  const body = profileImportBodySchema.safeParse(await req.readJson());
  const data = body.success ? body.data : {};
  const name = typeof data.name === "string" ? data.name : "imported";
  const content = typeof data.content === "string" ? data.content : "";
  const result = await ctx.profiles.importLocal(name, content);
  return { status: 200, json: result };
}

export async function activateProfile(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<RouteResponse> {
  const body = profileActivateBodySchema.safeParse(await req.readJson());
  if (!body.success) throw new ProfileInputError("Missing profile id string or null");
  const result = await ctx.profiles.activate(body.data.id);
  return { status: 200, json: result };
}

export async function updateAllProfiles(ctx: DaemonContext): Promise<RouteResponse> {
  // Partial failures ride in the 200 body so callers can render per-profile
  // errors without parsing an error envelope.
  const result = await ctx.profiles.updateAll();
  return { status: 200, json: result };
}

export async function updateProfile(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<RouteResponse> {
  const result = await ctx.profiles.update(requiredParam(req, "id"));
  return { status: 200, json: result };
}

export function readProfileContent(ctx: DaemonContext, req: DaemonRequest): RouteResponse {
  return { status: 200, json: ctx.profiles.readContent(requiredParam(req, "id")) };
}

export async function writeProfileContent(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<RouteResponse> {
  const body = profileContentBodySchema.safeParse(await req.readJson());
  if (!body.success) throw new ProfileInputError("A positive profile revision is required");
  const content = typeof body.data.content === "string" ? body.data.content : "";
  const result = await ctx.profiles.writeContent(
    requiredParam(req, "id"),
    content,
    body.data.revision,
  );
  return { status: 200, json: result };
}

export async function renameProfile(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<RouteResponse> {
  const body = profileRenameBodySchema.safeParse(await req.readJson());
  const name = body.success && typeof body.data.name === "string" ? body.data.name : "";
  const result = await ctx.profiles.rename(requiredParam(req, "id"), name);
  return { status: 200, json: result };
}

export async function removeProfile(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<RouteResponse> {
  const result = await ctx.profiles.remove(requiredParam(req, "id"));
  return { status: 200, json: result };
}

export async function proxyStatus(ctx: DaemonContext, req: DaemonRequest): Promise<RouteResponse> {
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

function readSettingsPatch(body: unknown): SettingsPatch {
  const parsed = settingsPatchBodySchema.safeParse(body);
  if (!parsed.success) {
    const unknownKey = parsed.error.issues.find((issue) => issue.code === "unrecognized_keys")
      ?.keys?.[0];
    throw new HttpError(
      400,
      unknownKey !== undefined ? `Unknown settings field: ${unknownKey}` : "Invalid settings patch",
    );
  }
  return parsed.data as SettingsPatch;
}

export function readSettings(ctx: DaemonContext): RouteResponse {
  return { status: 200, json: publicSettings(ctx.settings.committed()) };
}

export async function patchSettings(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<RouteResponse> {
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
