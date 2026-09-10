import {
  CORE_DELAY_TIMEOUT_MS,
  CORE_DELAY_URL,
  type CoreDelayResult,
  validateDelayTarget,
} from "./core-delay.js";
import { createDaemonClient } from "./daemon-client.js";
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
  validateDelayTarget(name);
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
      error: (error instanceof Error ? error.message : String(error))
        .replace(/\p{Cc}/gu, " ")
        .slice(0, 300),
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
  validateDelayTarget(name);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, options.signal]);
  let latest: CliRuntimeStatus | undefined;
  let observation: StatusDelayObservation | undefined;
  let owner = "";
  let generation = 0;
  let probeController: AbortController | undefined;
  let probing = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let finished = false;
  let failure: { error: unknown } | undefined;
  let dirty = false;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    dirty = true;
    wake?.();
    wake = undefined;
  };
  signal.addEventListener("abort", notify, { once: true });
  const sample = (): void => {
    if (signal.aborted || probeController || !latest) return;
    const current = latest;
    if (initialObservation(current, name).state === "unavailable") return;
    const expected = generation;
    const pending = new AbortController();
    probeController = pending;
    const probeSignal = AbortSignal.any([signal, pending.signal]);
    probing = Promise.resolve()
      .then(() => observeStatusDelay(context(), current, name, probeSignal, options.probe))
      .then((result) => {
        if (!probeSignal.aborted && expected === generation) {
          observation = result;
          notify();
        }
      })
      .catch((error: unknown) => {
        if (!probeSignal.aborted) {
          failure = { error };
          notify();
        }
      })
      .finally(() => {
        probeController = undefined;
        if (signal.aborted) return;
        if (expected !== generation) sample();
        else timer = setTimeout(sample, options.intervalMs ?? 30_000);
      });
  };
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
          generation += 1;
          probeController?.abort();
          clearTimeout(timer);
          observation = initialObservation(status, name);
          sample();
        }
        notify();
      }
    } catch (error) {
      if (!signal.aborted) failure = { error };
    } finally {
      finished = true;
      notify();
    }
  })();

  let previous = "";
  try {
    while (!signal.aborted) {
      if (!dirty)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      dirty = false;
      if (signal.aborted) return;
      if (failure) throw failure.error;
      if (latest && observation) {
        const status = withStatusDelay(latest, observation);
        const text = JSON.stringify(status);
        if (text !== previous) {
          previous = text;
          yield status;
        }
      }
      if (finished) return;
    }
  } finally {
    controller.abort();
    clearTimeout(timer);
    signal.removeEventListener("abort", notify);
    await Promise.allSettled([producer, probing]);
  }
}
