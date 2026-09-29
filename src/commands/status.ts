import { once } from "node:events";
import { cliOutputSignal } from "../cli-output.js";
import { printStatus } from "../cli-status.js";
import { validateDelayTarget } from "../core-delay.js";
import { errorMessage } from "../error-utils.js";
import { log } from "../log.js";

import {
  type CliRuntimeStatus,
  collectRuntimeStatus,
  markIncompleteObservation,
} from "../status.js";
import { observeStatusDelay, watchStatusWithDelay, withStatusDelay } from "../status-delay.js";
import { watchRuntimeStatus } from "../status-watch.js";
import { runtimeContext } from "./shared.js";

type RuntimeStatusCollector = () => Promise<CliRuntimeStatus>;

export async function runStatus(
  opts: { json?: boolean; watch?: boolean; delay?: string; verbose?: boolean } = {},
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
        if (!signal.aborted)
          await runStatus({ json: opts.json, verbose: opts.verbose }, async () => observed);
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
          else console.log(`\nUpdated ${new Date().toISOString()}`);
          await runStatus({ verbose: opts.verbose }, async () => status);
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

  printStatus(status, opts.verbose);
  markIncompleteObservation(status.complete);
}
