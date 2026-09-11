import { CORE_DELAY_TIMEOUT_MS, CORE_DELAY_URL, type CoreDelayResult } from "./core-delay.js";
import { createDaemonClient } from "./daemon-client.js";
import { errorDetail } from "./error-utils.js";
import type { CliRuntimeStatus, StatusObservationContext } from "./status.js";

export type StatusDelayObservation =
  | CoreDelayResult
  | {
      name: string;
      url: string;
      timeoutMs: number;
      testedAt: null;
      state: "pending" | "unavailable";
      delayMs: null;
      error: string | null;
    };

type DelayProbe = (
  context: StatusObservationContext,
  status: CliRuntimeStatus,
  name: string,
  signal: AbortSignal,
) => Promise<CoreDelayResult>;

function initialObservation(status: CliRuntimeStatus, name: string): StatusDelayObservation {
  const available =
    status.daemon.state === "healthy" &&
    status.core.running === true &&
    status.core.healthy === true;
  return {
    name,
    url: CORE_DELAY_URL,
    timeoutMs: CORE_DELAY_TIMEOUT_MS,
    testedAt: null,
    state: available ? "pending" : "unavailable",
    delayMs: null,
    error: available
      ? null
      : status.daemon.state === "stopped" || status.core.running === false
        ? "Start Core with sash start before testing delay"
        : "A healthy daemon and Core are required to test delay",
  };
}

/** Ordinary status never calls this; outbound traffic requires an explicit target. */
export async function observeStatusDelay(
  context: StatusObservationContext,
  status: CliRuntimeStatus,
  name: string,
  signal: AbortSignal,
  probe: DelayProbe = (context, status, name, signal) =>
    createDaemonClient(status.daemon.port, context.settings.daemonSecret).testDelay(name, signal),
): Promise<StatusDelayObservation> {
  signal.throwIfAborted();
  const initial = initialObservation(status, name);
  if (initial.state === "unavailable") return initial;
  try {
    return await probe(context, status, name, signal);
  } catch (error) {
    signal.throwIfAborted();
    return {
      ...initial,
      state: "unavailable",
      testedAt: null,
      delayMs: null,
      error: errorDetail(error),
    };
  }
}

export function withStatusDelay(
  status: CliRuntimeStatus,
  delay: StatusDelayObservation,
): CliRuntimeStatus {
  return {
    ...status,
    delay,
    complete: status.complete && delay.state === "ok",
    queryError:
      [status.queryError, delay.error ? `Delay test: ${delay.error}` : null]
        .filter(Boolean)
        .join("; ") || null,
  };
}

interface DelayWatchOptions {
  signal: AbortSignal;
  statuses: (signal: AbortSignal) => AsyncIterable<CliRuntimeStatus>;
  probe?: DelayProbe;
  intervalMs?: number;
}

/** Independent, non-overlapping sampling; status events never increase the probe frequency. */
export async function* watchStatusWithDelay(
  context: () => StatusObservationContext,
  name: string,
  options: DelayWatchOptions,
): AsyncGenerator<CliRuntimeStatus> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, options.signal]);
  const intervalMs = options.intervalMs ?? 30_000;
  let latest: CliRuntimeStatus | undefined;
  let observation: StatusDelayObservation | undefined;
  let owner = "";
  let failed: unknown;
  let hasFailed = false;
  let finished = false;
  let dirty = false;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    dirty = true;
    wake?.();
  };
  signal.addEventListener("abort", notify, { once: true });

  // Probes run strictly one at a time: each starts only after the previous
  // settled. A runtime-identity change aborts the in-flight probe and
  // re-probes immediately instead of waiting out the interval.
  let probing = false;
  let probeAgain = false;
  let probeAbort: AbortController | undefined;
  let timer: NodeJS.Timeout | undefined;

  const runProbe = async (status: CliRuntimeStatus): Promise<void> => {
    probing = true;
    const pending = new AbortController();
    probeAbort = pending;
    const probeSignal = AbortSignal.any([signal, pending.signal]);
    try {
      const result = await observeStatusDelay(context(), status, name, probeSignal, options.probe);
      // An aborted probe belongs to a replaced runtime; its result is stale.
      if (!pending.signal.aborted) observation = result;
    } catch (error) {
      if (!pending.signal.aborted && !signal.aborted) {
        failed = error;
        hasFailed = true;
      }
    } finally {
      probing = false;
      probeAbort = undefined;
      notify();
      if (!signal.aborted) {
        if (probeAgain) {
          probeAgain = false;
          requestProbe();
        } else {
          timer = setTimeout(requestProbe, intervalMs);
        }
      }
    }
  };

  function requestProbe(): void {
    if (signal.aborted) return;
    const status = latest;
    if (!status || initialObservation(status, name).state === "unavailable") return;
    if (probing) {
      probeAgain = true;
      probeAbort?.abort();
      return;
    }
    void runProbe(status);
  }

  const producer = (async () => {
    try {
      for await (const status of options.statuses(signal)) {
        if (signal.aborted) return;
        latest = status;
        const nextOwner = JSON.stringify([
          status.daemon.state,
          status.daemon.pid,
          status.daemon.port,
          status.core.running,
          status.core.healthy,
          status.core.pid,
          status.core.version,
        ]);
        if (nextOwner !== owner) {
          owner = nextOwner;
          observation = initialObservation(status, name);
          clearTimeout(timer);
          requestProbe();
        }
        notify();
      }
    } catch (error) {
      if (!signal.aborted) {
        failed = error;
        hasFailed = true;
      }
    } finally {
      finished = true;
      notify();
    }
  })();

  try {
    while (!signal.aborted) {
      if (!dirty)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      dirty = false;
      if (signal.aborted) return;
      if (hasFailed) throw failed;
      if (latest && observation) yield withStatusDelay(latest, observation);
      if (finished) return;
    }
  } finally {
    controller.abort();
    clearTimeout(timer);
    probeAbort?.abort();
    signal.removeEventListener("abort", notify);
    await producer;
  }
}
