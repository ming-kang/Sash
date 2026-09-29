import { commandOutput } from "../cli-output.js";
import { printSystemProxyWarnings, systemProxyValue } from "../cli-status.js";
import type { SystemProxyStatusResponse } from "../contracts.js";
import {
  ensureDaemonSession,
  type RuntimeContext,
  resolveDaemonSession,
} from "../daemon-session.js";
import { log } from "../log.js";
import { SystemProxyManager } from "../sysproxy/manager.js";
import { runtimeContext } from "./shared.js";

export type ProxyAction = "on" | "off" | "status";

export async function inspectCliProxy(context: RuntimeContext): Promise<SystemProxyStatusResponse> {
  const owner = await resolveDaemonSession(context);
  if (owner.kind === "daemon") return owner.client.proxyStatus();
  const result = await new SystemProxyManager({ layout: context.layout }).inspect();
  return {
    ...result.state,
    desired: context.settings.systemProxy,
    applied: result.applied,
    appliedKnown: result.appliedKnown,
    stateKnown: result.stateKnown,
    ...(result.queryError ? { queryError: result.queryError } : {}),
  };
}

export async function setCliProxy(
  context: RuntimeContext,
  enabled: boolean,
): Promise<SystemProxyStatusResponse> {
  const { client } = await ensureDaemonSession(context);
  await client.patchSettings({ systemProxy: enabled });
  return client.proxyStatus();
}

export async function runProxy(
  action: ProxyAction = "status",
  options: { json?: boolean } = {},
): Promise<void> {
  await commandOutput(
    options.json,
    async () => {
      const context = runtimeContext();
      const result = await (action === "status"
        ? inspectCliProxy(context)
        : setCliProxy(context, action === "on"));
      if (!result.appliedKnown || !result.stateKnown || result.queryError) process.exitCode = 2;
      return result;
    },
    (result) => {
      const observed = {
        supported: result.stateKnown ? result.supported : null,
        enabled: result.stateKnown ? result.enabled : null,
        server: result.server ?? null,
        details: result.queryError ?? null,
      };
      const rows = [["System Proxy", systemProxyValue(observed)]];
      if (observed.enabled !== null && observed.enabled !== result.desired) {
        rows.push(["Sash Setting", result.desired ? "On" : "Off"]);
        if (observed.server) rows.push(["Windows", observed.server]);
      }
      log.table(rows);
      printSystemProxyWarnings(result.desired, observed);
      if (result.queryError) log.warn(result.queryError);
    },
  );
}
