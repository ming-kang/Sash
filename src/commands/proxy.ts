import { commandOutput } from "../cli-output.js";
import { inspectCliProxy, setCliProxy } from "../cli-proxy.js";
import { log } from "../log.js";
import { formatSystemProxyLine } from "../status.js";
import { runtimeContext } from "./shared.js";

export type ProxyAction = "on" | "off" | "status";

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
