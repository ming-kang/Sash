import type {
  DaemonStatus,
  HealthInfo,
  WebBootstrapInfo,
  WebSessionInfo,
} from "../../contracts.js";
import { currentCoreVersion } from "../../core.js";
import { HttpError } from "../../daemon-http.js";
import { UPGRADE_PROTOCOL } from "../../package-info.js";
import { publicSettings } from "../../settings.js";
import type { SystemProxyState } from "../../sysproxy.js";
import type { DaemonContext } from "../context.js";
import type { RouteRequest, RouteResponse } from "../router.js";

export function health(ctx: DaemonContext): RouteResponse {
  // The token is a per-boot identity nonce for daemon instance matching. It
  // is deliberately not a credential: control requests require the CLI
  // bearer or a WebUI session token from the bootstrap exchange below.
  const continuation = ctx.webAuth.continuationInfo();
  const body: HealthInfo = {
    token: ctx.token,
    pid: process.pid,
    startedAt: ctx.startedAt,
    version: ctx.version,
    installationId: ctx.installationId,
    upgradeProtocol: UPGRADE_PROTOCOL,
    ...(continuation ? { webContinuation: continuation } : {}),
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
  const ownership = ctx.supervisor.ownedCoreSnapshot();
  const runtimeCore = await ctx.supervisor.status({ fresh });
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
    const inspection = await ctx.systemProxy.inspect(fresh);
    proxyApplied = inspection.applied;
    proxyAppliedKnown = inspection.appliedKnown;
    proxyStateKnown = inspection.stateKnown;
    actualProxy = inspection.state;
    proxyQueryError = inspection.queryError;
  } catch (err) {
    proxyQueryError = err instanceof Error ? err.message : String(err);
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
      installationId: ctx.installationId,
    },
    revisions: {
      state: ctx.stateRevision(),
      runtime: ctx.lifecycle.revision,
    },
    mutationQueue: ctx.gate.snapshot(),
    configuration: {
      pending: ctx.pendingApply(),
      appliedProfile: applied?.profile
        ? { ...applied.profile, url: req.authorized ? applied.profile.url : "" }
        : null,
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
    activeProfile: active
      ? { id: active.id, name: active.name, url: req.authorized ? active.url : "" }
      : null,
  };
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
