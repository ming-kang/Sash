import type { SystemProxyStatusResponse } from "./contracts.js";
import { ensureManagement, type RuntimeContext, resolveRuntimeOwner } from "./runtime-owner.js";
import { SystemProxyManager } from "./system-proxy-manager.js";

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
