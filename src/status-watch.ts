import { setTimeout as delay } from "node:timers/promises";
import { createDaemonClient } from "./daemon-client.js";
import { readDaemonPidRecord } from "./daemon-lifecycle.js";
import { SashApiError } from "./sash-client.js";
import type { DaemonEvent } from "./sash-events.js";
import {
  type CliRuntimeStatus,
  collectRuntimeStatus,
  type StatusObservationContext,
} from "./status.js";

export function collectEventStatus(
  context: StatusObservationContext,
  event: DaemonEvent,
): Promise<CliRuntimeStatus> {
  const { status } = event;
  return collectRuntimeStatus(context, {
    evaluateDaemon: async () => ({
      kind: "healthy",
      running: true,
      healthy: true,
      pid: status.daemon.pid,
      port: status.daemon.port,
    }),
    queryDaemonStatus: async () => status,
    inspectAutostart: async () => event.autostart,
    inspectSystemProxy: async () => ({
      applied: status.systemProxy.applied,
      appliedKnown: status.systemProxy.appliedKnown,
      stateKnown: status.systemProxy.stateKnown && status.systemProxy.actual !== undefined,
      state: status.systemProxy.actual ?? { supported: false, enabled: false },
      ...(status.systemProxy.queryError ? { queryError: status.systemProxy.queryError } : {}),
    }),
    activeProfile: () => status.activeProfile,
  });
}

async function* openEvents(
  context: StatusObservationContext,
  observed: CliRuntimeStatus,
  signal: AbortSignal,
): AsyncGenerator<DaemonEvent> {
  const owner = readDaemonPidRecord(context.layout);
  const client = createDaemonClient(observed.daemon.port, context.settings.daemonSecret);
  for await (const event of client.events(signal)) {
    if (
      owner &&
      (event.status.daemon.bootId !== owner.token || event.status.daemon.pid !== owner.pid)
    )
      throw new Error("Daemon event identity does not match this instance");
    yield event;
  }
}

export interface StatusWatchOptions {
  signal: AbortSignal;
  onReconnect?: (error: unknown) => void;
  retryMs?: number;
  collect?: typeof collectRuntimeStatus;
  events?: typeof openEvents;
  fromEvent?: typeof collectEventStatus;
}

/** Read-only across stop/start and upgrades. Rediscovery never starts management. */
export async function* watchRuntimeStatus(
  context: () => StatusObservationContext,
  options: StatusWatchOptions,
): AsyncGenerator<CliRuntimeStatus> {
  let previous = "";
  let failures = 0;
  const { signal } = options;
  while (!signal.aborted) {
    const current = context();
    const status = await (options.collect ?? collectRuntimeStatus)(current);
    if (signal.aborted) return;
    const text = JSON.stringify(status);
    if (text !== previous) {
      previous = text;
      yield status;
    }
    if (status.daemon.state === "healthy") {
      try {
        for await (const event of (options.events ?? openEvents)(current, status, signal)) {
          if (signal.aborted) return;
          failures = 0;
          const next = await (options.fromEvent ?? collectEventStatus)(current, event);
          if (signal.aborted) return;
          const text = JSON.stringify(next);
          if (text !== previous) {
            previous = text;
            yield next;
          }
        }
        if (!signal.aborted) throw new Error("Daemon event stream closed");
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof SashApiError && [400, 401, 403, 404, 405].includes(error.status))
          throw error;
        options.onReconnect?.(error);
        failures += 1;
      }
    }
    try {
      await delay(
        Math.min(10_000, (options.retryMs ?? 1000) * 2 ** Math.min(failures, 4)),
        undefined,
        { signal },
      );
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
