import { MihomoApi } from "../api.js";
import { parseAutostartEnabled } from "../autostart-contract.js";
import type {
  DaemonStatus,
  HealthInfo,
  SettingsPatch,
  SystemProxyStatusResponse,
  WebBootstrapInfo,
  WebSessionInfo,
} from "../contracts.js";
import { currentCoreVersion } from "../core.js";
import { validateDelayTarget } from "../core-delay.js";
import { validateCoreReleaseTag } from "../core-install-record.js";
import { errorMessage } from "../error-utils.js";
import { isPlainObject } from "../json-shape.js";
import { ProfileInputError } from "../profile-service.js";
import { publicSettings } from "../settings.js";
import type { SystemProxyState } from "../sysproxy.js";
import type { DaemonContext } from "./context.js";
import { HttpError, requiredParam } from "./http.js";
import type { RouteRequest, RouteResponse } from "./router.js";

/* ── autostart ── */

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
  const status = await ctx.mutate(() => ctx.autostart.set(enabled));
  return { status: 200, json: status };
}

/* ── core ── */

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
export function coreUpdateProgress(ctx: DaemonContext): RouteResponse {
  return { status: 200, json: ctx.coreUpdate };
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
    throw new HttpError(400, errorMessage(error));
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

export async function testCoreDelay(ctx: DaemonContext, req: RouteRequest): Promise<RouteResponse> {
  const body = await req.readJson(4096);
  let name: string;
  try {
    if (Object.keys(body).some((key) => key !== "name"))
      throw new TypeError("Expected only a node or group name");
    name = validateDelayTarget(body.name);
  } catch (error) {
    throw new HttpError(400, errorMessage(error));
  }
  const result = await ctx.gate.runLiveMutation(async () => {
    req.signal.throwIfAborted();
    const owner = ctx.supervisor.ownedCoreSnapshot();
    if (!owner) throw new HttpError(409, "A running owned Core is required for a delay test");
    const settings = ctx.settings.runtime();
    const result = await new MihomoApi(settings.controller, settings.secret).delay(
      name,
      req.signal,
    );
    if (!ctx.supervisor.ownsCore(owner))
      throw new HttpError(409, "Core changed during the delay test; try again");
    return result;
  });
  return { status: 200, json: result };
}

/* ── daemon ── */

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

/** Authenticated CLI clients mint a one-time bootstrap token for `sash web`. */
export function createWebBootstrap(ctx: DaemonContext): RouteResponse {
  const bootstrap = ctx.webAuth.createBootstrap();
  const body: WebBootstrapInfo = { token: bootstrap.token, expiresAt: bootstrap.expiresAt };
  return { status: 200, json: body };
}

/** Public exchange: a valid one-time bootstrap token becomes a session token. */
export async function redeemWebBootstrap(
  ctx: DaemonContext,
  req: RouteRequest,
): Promise<RouteResponse> {
  const body = await req.readJson(1024);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const session = ctx.webAuth.redeemBootstrap(token);
  if (!session) throw new HttpError(401, "Invalid or expired bootstrap token");
  const response: WebSessionInfo = { token: session, daemonToken: ctx.token };
  return { status: 200, json: response };
}

export async function daemonStatus(ctx: DaemonContext, req: RouteRequest): Promise<RouteResponse> {
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

/** Complete control snapshot shared by HTTP reads and the authenticated event observer. */
export async function readDaemonStatus(
  ctx: DaemonContext,
  freshProxy = false,
): Promise<DaemonStatus> {
  const ownership = ctx.supervisor.ownedCoreSnapshot();
  const runtimeCore = await ctx.supervisor.status();
  const installedVersion = currentCoreVersion(ctx.layout);
  let core =
    runtimeCore.version || !installedVersion
      ? runtimeCore
      : { ...runtimeCore, version: installedVersion };
  let actualProxy: SystemProxyState | undefined;
  let proxyApplied = false;
  let proxyAppliedKnown = false;
  let proxyStateKnown = false;
  let proxyQueryError: string | undefined;
  try {
    const inspection = await ctx.systemProxy.inspect(freshProxy);
    proxyApplied = inspection.applied;
    proxyAppliedKnown = inspection.appliedKnown;
    proxyStateKnown = inspection.stateKnown;
    actualProxy = inspection.state;
    proxyQueryError = inspection.queryError;
  } catch (err) {
    proxyQueryError = errorMessage(err);
  }
  // Read saved values and their revision together after asynchronous observations.
  const settings = ctx.settings.committed();
  const active = ctx.profiles.active();
  if (core.running && (!ownership || !ctx.supervisor.ownsCore(ownership)))
    core = { running: false };
  const applied = ctx.lifecycle.configuration();
  const status: DaemonStatus = {
    coreUpdate: ctx.coreUpdate,
    daemon: {
      pid: process.pid,
      bootId: ctx.token,
      startedAt: ctx.startedAt,
      port: settings.daemonPort,
      version: ctx.version,
    },
    revisions: {
      state: ctx.stateRevision(),
      runtime: ctx.lifecycle.revision,
    },
    configuration: {
      pending: ctx.pendingApply(),
      appliedProfile: applied?.profile ? { ...applied.profile } : null,
      appliedSettings: applied
        ? { mixedPort: applied.settings.mixedPort, allowLan: applied.settings.allowLan }
        : null,
    },
    core,
    systemProxy: {
      desired: settings.systemProxy,
      applied: proxyApplied,
      actual: actualProxy,
      appliedKnown: proxyAppliedKnown,
      stateKnown: proxyStateKnown,
      ...(proxyQueryError ? { queryError: proxyQueryError } : {}),
    },
    settings: publicSettings(settings),
    activeProfile: active ? { id: active.id, name: active.name, url: active.url } : null,
  };
  return status;
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

/* ── profiles ── */

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

/* ── proxy ── */

export async function proxyStatus(ctx: DaemonContext, req: RouteRequest): Promise<RouteResponse> {
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

/* ── settings ── */

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
