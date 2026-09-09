import { commandOutput } from "../cli-output.js";
import { inspectCliProxy, setCliProxy } from "../cli-proxy.js";
import { log } from "../log.js";
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
      log.kv("desired", result.desired ? "on" : "off");
      log.kv("Sash applied", result.appliedKnown ? (result.applied ? "on" : "off") : "unknown");
      log.kv(
        "OS proxy",
        !result.stateKnown
          ? "unknown"
          : !result.supported
            ? "unsupported"
            : result.enabled
              ? `on (${result.server ?? "unknown server"})`
              : "off",
      );
      if (result.queryError) log.warn(result.queryError);
    },
  );
}
