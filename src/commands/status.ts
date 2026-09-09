import { once } from "node:events";
import { cliOutputSignal } from "../cli-output.js";
import { validateDelayTarget } from "../core-delay.js";
import { log } from "../log.js";
import {
  type CliRuntimeStatus,
  collectRuntimeStatus,
  formatObservedProxy,
  markIncompleteObservation,
  runtimeStatusHeadline,
} from "../status.js";
import { observeStatusDelay, watchStatusWithDelay, withStatusDelay } from "../status-delay.js";
import { watchRuntimeStatus } from "../status-watch.js";
import { runtimeContext } from "./shared.js";

export type RuntimeStatusCollector = () => Promise<CliRuntimeStatus>;

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
            log.warn(
              `status stream disconnected; reconnecting: ${error instanceof Error ? error.message : String(error)}`,
            ),
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
  if (status.queryError) log.warn(`status incomplete: ${status.queryError}`);

  log.kv("root", status.paths.root);
  log.kv("autostart", status.autostart.state);
  if (status.autostart.state === "stale" || status.autostart.state === "disabled") {
    log.warn("Run sash auto on to repair the login startup registration");
  }
  log.kv("config", status.paths.config);
  log.kv("mixed port", status.endpoints.mixedProxy);
  log.kv("proxy desired", status.systemProxy.desired ? "on" : "off");
  log.kv(
    "daemon applied",
    status.systemProxy.daemonApplied === null
      ? status.daemon.state === "stopped"
        ? "n/a (stopped)"
        : "unknown"
      : status.systemProxy.daemonApplied
        ? "yes"
        : "no",
  );
  log.kv("os proxy", formatObservedProxy(status.systemProxy.osObserved));
  log.kv("sash api", status.endpoints.daemonApi);
  log.kv("dashboard", status.endpoints.dashboard);
  log.kv(
    "selected profile",
    status.activeProfile
      ? `${status.activeProfile.name} (${status.activeProfile.url || "local file"})`
      : "(none)",
  );
  log.kv("core version", status.core.installedVersion || "(not installed)");
  if (status.delay) {
    const delay = status.delay;
    log.kv(
      "delay",
      `${delay.name}: ${delay.state === "ok" ? `${delay.delayMs} ms` : delay.state === "pending" ? "testing…" : delay.state.replaceAll("_", " ")}`,
    );
  }
  markIncompleteObservation(status.complete);
}
