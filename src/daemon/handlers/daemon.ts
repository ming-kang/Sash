import type { DaemonStatus, HealthInfo, ShutdownResult } from "../../contracts.js";
import { currentCoreVersion } from "../../core.js";
import { publicSettings } from "../../settings.js";
import type { SystemProxyState } from "../../sysproxy.js";
import type { DaemonContext } from "../context.js";
import type { RouteRequest, RouteResponse } from "../router.js";

export function health(ctx: DaemonContext): RouteResponse {
  const body: HealthInfo = { token: ctx.token, pid: process.pid, startedAt: ctx.startedAt };
  return { status: 200, json: body };
}

export async function daemonStatus(ctx: DaemonContext, req: RouteRequest): Promise<RouteResponse> {
  const settings = ctx.settings.committed();
  const runtimeCore = await ctx.supervisor.status();
  const installedVersion = currentCoreVersion(ctx.layout);
  const core =
    runtimeCore.version || !installedVersion
      ? runtimeCore
      : { ...runtimeCore, version: installedVersion };
  let actualProxy: SystemProxyState | undefined;
  let proxyApplied = false;
  let proxyAppliedKnown = false;
  let proxyStateKnown = false;
  let proxyQueryError: string | undefined;
  try {
    const inspection = await ctx.systemProxy.inspect(req.searchParams.get("fresh") === "1");
    proxyApplied = inspection.applied;
    proxyAppliedKnown = inspection.appliedKnown;
    proxyStateKnown = inspection.stateKnown;
    if (proxyStateKnown) actualProxy = inspection.state;
    proxyQueryError = inspection.queryError;
  } catch (err) {
    proxyQueryError = err instanceof Error ? err.message : String(err);
  }
  const active = ctx.profiles.active();
  const status: DaemonStatus = {
    daemon: {
      pid: process.pid,
      startedAt: ctx.startedAt,
      port: settings.daemonPort,
    },
    revisions: {
      profiles: ctx.profileRevision(),
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
  return { status: 200, json: status };
}

export function shutdownDaemon(ctx: DaemonContext): Promise<RouteResponse> {
  return ctx.shutdown().then((snapshot: ShutdownResult) => ({
    status: 200,
    json: { coreWasRunning: snapshot.coreWasRunning } satisfies ShutdownResult,
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
