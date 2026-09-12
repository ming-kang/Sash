import { once } from "node:events";
import { cliOutputSignal } from "../cli-output.js";
import { validateDelayTarget } from "../core-delay.js";
import { errorMessage } from "../error-utils.js";
import { log } from "../log.js";
import { readSashPackageInfo } from "../package-info.js";
import {
  type CliRuntimeStatus,
  collectRuntimeStatus,
  formatAutostart,
  formatLoginStartSuffix,
  formatSystemProxyLine,
  markIncompleteObservation,
  runtimeStatusHeadline,
} from "../status.js";
import { observeStatusDelay, watchStatusWithDelay, withStatusDelay } from "../status-delay.js";
import { watchRuntimeStatus } from "../status-watch.js";
import { runtimeContext } from "./shared.js";

type RuntimeStatusCollector = () => Promise<CliRuntimeStatus>;

export async function runStatus(
  opts: { json?: boolean; watch?: boolean; delay?: string } = {},
  collect: RuntimeStatusCollector = () => collectRuntimeStatus(runtimeContext()),
): Promise<void> {
  if (opts.delay !== undefined) validateDelayTarget(opts.delay);
  if (opts.watch || opts.delay !== undefined) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, cliOutputSignal]);
    const stop = (): void => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const initialExitCode = process.exitCode;
    let last: CliRuntimeStatus | undefined;
    try {
      if (!opts.watch && opts.delay !== undefined) {
        const status = await collect();
        const observed = withStatusDelay(
          status,
          await observeStatusDelay(runtimeContext(), status, opts.delay, signal),
        );
        last = observed;
        if (!signal.aborted) await runStatus({ json: opts.json }, async () => observed);
        return;
      }
      const statuses = (signal: AbortSignal) =>
        watchRuntimeStatus(runtimeContext, {
          signal,
          onReconnect: (error) =>
            log.warn(`status stream disconnected; reconnecting: ${errorMessage(error)}`),
        });
      const snapshots =
        opts.delay === undefined
          ? statuses(signal)
          : watchStatusWithDelay(runtimeContext, opts.delay, { signal, statuses });
      for await (const status of snapshots) {
        last = status;
        if (opts.json) {
          if (!process.stdout.write(`${JSON.stringify(status)}\n`))
            await once(process.stdout, "drain", { signal });
        } else {
          if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
          else console.log(`\n[sash] ${new Date().toISOString()}`);
          await runStatus({}, async () => status);
        }
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      controller.abort();
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      if (cliOutputSignal.aborted) process.exitCode = 0;
      else if (last?.complete && process.exitCode === 2) process.exitCode = initialExitCode;
      else if (last) markIncompleteObservation(last.complete);
    }
    return;
  }
  const status = await collect();

  if (opts.json) {
    console.log(JSON.stringify(status, null, 2));
    markIncompleteObservation(status.complete);
    return;
  }

  const headline = runtimeStatusHeadline(status);
  log[headline.level](headline.text);
  if (status.queryError) log.warn(`some details are unavailable: ${status.queryError}`);

  log.kv(
    "profile",
    status.activeProfile
      ? `${status.activeProfile.name} (${status.activeProfile.url ? "subscription" : "local file"})`
      : "none selected — using the built-in configuration",
  );
  log.kv("proxy port", status.endpoints.mixedProxy);
  log.kv(
    "system proxy",
    formatSystemProxyLine(status.systemProxy.desired, status.systemProxy.osObserved),
  );
  log.kv("dashboard", status.endpoints.dashboard);
  log.kv("local API", status.endpoints.daemonApi);
  // The headline already names the running version; this line answers
  // "is a Core installed" while it is stopped.
  if (status.core.running !== true) log.kv("core", status.core.installedVersion || "not installed");
  // A daemon keeps executing the code it started with; say so when the installed
  // package has moved on, instead of leaving the mismatch silent.
  const runningVersion = status.daemon.version;
  if (runningVersion) {
    const installedVersion = readSashPackageInfo().version;
    if (runningVersion !== installedVersion) {
      log.kv(
        "sash",
        `${runningVersion} running · ${installedVersion} installed — run sash stop && sash start to load it`,
      );
    }
  }
  if (status.delay) {
    const delay = status.delay;
    log.kv(
      "latency test",
      `${delay.name}: ${delay.state === "ok" ? `${delay.delayMs} ms` : delay.state === "pending" ? "testing…" : delay.state.replaceAll("_", " ")}`,
    );
  }
  log.kv(
    "start at login",
    `${formatAutostart(status.autostart)}${formatLoginStartSuffix(status.loginStart)}`,
  );
  log.kv("data folder", status.paths.root);
  log.kv("core config", status.paths.config);
  markIncompleteObservation(status.complete);
}
