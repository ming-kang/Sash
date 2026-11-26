import type { DaemonStatus } from "../contracts.js";
import { currentCoreVersion } from "../core.js";
import { errorMessage } from "../error-utils.js";
import { publicSettings } from "../settings.js";
import type { SystemProxyState } from "../sysproxy/types.js";
import type { DaemonContext } from "./context.js";

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
  const committedSettings = ctx.settings.committed();
  const activeProfile = ctx.profiles.active();
  if (core.running && (!ownership || !ctx.supervisor.ownsCore(ownership)))
    core = { running: false };
  const configurationState = ctx.core.configurationState(core);
  const applied = ctx.lifecycle.configuration();
  const transport = ctx.core.downloadTransport();
  if (transport) {
    try {
      const address = new URL(transport.uri);
      if (address.username || address.password) {
        address.username = "";
        address.password = "";
        transport.uri = address.href;
      }
    } catch {
      transport.uri = "";
    }
  }
  const status: DaemonStatus = {
    coreUpdate: ctx.core.progress,
    downloadTransport: transport,
    daemon: {
      pid: process.pid,
      bootId: ctx.bootId,
      startedAt: ctx.startedAt,
      port: committedSettings.daemonPort,
      version: ctx.version,
    },
    revisions: {
      state: ctx.stateRevision(),
      runtime: ctx.lifecycle.revision,
    },
    configuration: {
      pending: configurationState.pending,
      pendingChanges: configurationState.pendingChanges,
      applyMethod: configurationState.applyMethod,
      appliedProfile: applied?.profile ? { ...applied.profile } : null,
      appliedSettings: applied
        ? {
            mixedPort: applied.settings.mixedPort,
            allowLan: applied.settings.allowLan,
            tun: applied.settings.tun,
          }
        : null,
    },
    core,
    systemProxy: {
      desired: committedSettings.systemProxy,
      applied: proxyApplied,
      actual: actualProxy,
      appliedKnown: proxyAppliedKnown,
      stateKnown: proxyStateKnown,
      ...(proxyQueryError ? { queryError: proxyQueryError } : {}),
    },
    settings: publicSettings(committedSettings),
    activeProfile: activeProfile
      ? { id: activeProfile.id, name: activeProfile.name, url: activeProfile.url }
      : null,
  };
  const tunGuard = ctx.lifecycle.tunGuard;
  if (tunGuard?.supported) {
    const last = tunGuard.lastResult();
    status.tunGuard = {
      supported: true,
      lastReconcile: last
        ? { state: last.state, verb: last.verb, detail: last.detail, at: last.at }
        : null,
    };
  }
  return status;
}
