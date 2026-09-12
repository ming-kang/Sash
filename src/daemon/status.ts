import type { DaemonStatus } from "../contracts.js";
import { currentCoreVersion } from "../core.js";
import { errorMessage } from "../error-utils.js";
import { publicSettings } from "../settings.js";
import type { SystemProxyState } from "../sysproxy.js";
import type { DaemonContext } from "./context.js";

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
