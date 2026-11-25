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
import type { HealthInfo, SettingsPatch, SystemProxyStatusResponse } from "../contracts.js";
import { validateCoreReleaseTag } from "../core.js";
import { validateDelayTarget } from "../core-delay.js";
import { errorMessage } from "../error-utils.js";
import { ProfileInputError } from "../profile-service.js";
import { publicSettings } from "../settings.js";
import type { DaemonContext } from "./context.js";
import { HttpError } from "./http.js";
import type { DaemonRequest, RouteDef, RouteResponse } from "./router.js";
import { readDaemonStatus } from "./status.js";
import { currentTunStatus } from "./tun-read.js";

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
      methods: ["GET"],
      path: "/sash/core/update/check",
      auth: "control",
      handler: checkCoreUpdate,
    },
    {
      methods: ["DELETE"],
      path: "/sash/core/update",
      auth: "control",
      handler: cancelCoreUpdate,
    },
    { methods: ["GET"], path: "/sash/proxy", auth: "public", handler: proxyStatus },
    { methods: ["GET"], path: "/sash/tun", auth: "control", handler: readTun },
    {
      methods: ["POST"],
      path: "/sash/tun/helper/install",
      auth: "control",
      handler: (ctx, req) => setTunHelper(ctx, req, true),
    },
    {
      methods: ["POST"],
      path: "/sash/tun/helper/uninstall",
      auth: "control",
      handler: (ctx, req) => setTunHelper(ctx, req, false),
    },
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
export async function checkCoreUpdate(ctx: DaemonContext): Promise<RouteResponse> {
  return { status: 200, json: await ctx.core.checkUpdate() };
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
    await ctx.supervisor.controllerApi(settings).setMode(body.data.mode);
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
    const result = await ctx.supervisor.controllerApi(settings).delay(name, req.signal);
    if (!ctx.supervisor.ownsCore(owner))
      throw new HttpError(409, "Core changed during the delay test; try again");
    return result;
  });
  return { status: 200, json: result };
}

export function health(ctx: DaemonContext): RouteResponse {
  const body: HealthInfo = {
    bootId: ctx.bootId,
    pid: process.pid,
    startedAt: ctx.startedAt,
    version: ctx.version,
  };
  return { status: 200, json: body };
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
  if (!body.success)
    throw new ProfileInputError("Expected a profile URL with optional name and activate flag");
  const name = body.data.name?.trim();
  const result = await ctx.profiles.addRemote(body.data.url?.trim() ?? "", {
    ...(name ? { name } : {}),
    activate: body.data.activate === true,
  });
  return { status: 200, json: result };
}

export async function importProfile(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<RouteResponse> {
  const body = profileImportBodySchema.safeParse(await req.readJson());
  if (!body.success) throw new ProfileInputError("Expected profile content with an optional name");
  const result = await ctx.profiles.importLocal(
    body.data.name ?? "imported",
    body.data.content ?? "",
  );
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
  if (!body.success)
    throw new ProfileInputError("Expected profile content with a positive revision");
  const result = await ctx.profiles.writeContent(
    requiredParam(req, "id"),
    body.data.content ?? "",
    body.data.revision,
  );
  return { status: 200, json: result };
}

export async function renameProfile(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<RouteResponse> {
  const body = profileRenameBodySchema.safeParse(await req.readJson());
  if (!body.success) throw new ProfileInputError("Expected a profile name");
  const result = await ctx.profiles.rename(requiredParam(req, "id"), body.data.name ?? "");
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
    const first = parsed.error.issues[0];
    const detail = first
      ? `${first.path.join(".") ? `${first.path.join(".")}: ` : ""}${first.message}`
      : "";
    throw new HttpError(
      400,
      unknownKey !== undefined
        ? `Unknown settings field: ${unknownKey}`
        : `Invalid settings patch: ${detail}`,
    );
  }
  return parsed.data;
}

async function readTun(ctx: DaemonContext): Promise<RouteResponse> {
  return { status: 200, json: await currentTunStatus(ctx, true) };
}

function readTunHelperAuth(body: Record<string, unknown>): "sudo" | "pkexec" | undefined {
  const value = body.helperAuth;
  if (value === undefined) return undefined;
  if (value === "sudo" || value === "pkexec") return value;
  throw new HttpError(400, 'helperAuth must be "sudo" or "pkexec"');
}

async function setTunHelper(
  ctx: DaemonContext,
  req: DaemonRequest,
  install: boolean,
): Promise<RouteResponse> {
  const peer = req.raw.socket.remoteAddress;
  if (peer !== "127.0.0.1" && peer !== "::1" && peer !== "::ffff:127.0.0.1")
    throw new HttpError(403, "TUN helper administration is local only", "unauthorized");
  if (!ctx.tun.supported) throw new HttpError(501, "TUN Mode is not available on this platform");
  const helperAuth = readTunHelperAuth(await req.readJson());
  await ctx.mutate(async () => {
    if (ctx.supervisor.isRunning() && ctx.lifecycle.configuration()?.settings.tun.enable)
      throw new HttpError(409, "Disable TUN and Apply before changing the helper", "conflict");
    const proxyUri = ctx.core.downloadTransport()?.uri;
    await ctx.tun.setInstalled(install, {
      ...(proxyUri !== undefined ? { proxyUri } : {}),
      ...(helperAuth !== undefined ? { helperAuth } : {}),
    });
  });
  return readTun(ctx);
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
