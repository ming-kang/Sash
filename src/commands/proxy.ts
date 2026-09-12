import { commandOutput } from "../cli-output.js";
import type { SystemProxyStatusResponse } from "../contracts.js";
import { log } from "../log.js";
import { ensureManagement, type RuntimeContext, resolveRuntimeOwner } from "../runtime-owner.js";
import { formatSystemProxyLine } from "../status.js";
import { SystemProxyManager } from "../system-proxy-manager.js";
import { runtimeContext } from "./shared.js";

export type ProxyAction = "on" | "off" | "status";

export async function inspectCliProxy(context: RuntimeContext): Promise<SystemProxyStatusResponse> {
  const owner = await resolveRuntimeOwner(context);
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
  const { client } = await ensureManagement(context);
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
      log.kv(
        "system proxy",
        formatSystemProxyLine(result.desired, {
          supported: result.stateKnown ? result.supported : null,
          enabled: result.stateKnown ? result.enabled : null,
          server: result.server ?? null,
          details: null,
        }),
      );
      if (result.queryError) log.warn(result.queryError);
    },
  );
}
