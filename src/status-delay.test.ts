import assert from "node:assert/strict";
import { it } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import {
  CORE_DELAY_TIMEOUT_MS,
  CORE_DELAY_URL,
  type CoreDelayResult,
  parseCoreDelayResult,
} from "./core-delay.js";
import type { CliRuntimeStatus } from "./status.js";
import { observeStatusDelay, watchStatusWithDelay, withStatusDelay } from "./status-delay.js";
import { collectEventStatus } from "./status-watch.js";
import { useDaemonTestHarness } from "./testing/daemon-harness.js";
import { deferred, testStatus } from "./testing/state.js";

const h = useDaemonTestHarness();
const context = () => ({ layout: h.layout, settings: h.settings });
const measurement = (delayMs: number): CoreDelayResult => ({
  name: "group",
  url: CORE_DELAY_URL,
  timeoutMs: CORE_DELAY_TIMEOUT_MS,
  testedAt: new Date().toISOString(),
  state: "ok",
  delayMs,
  error: null,
});

function status(): Promise<CliRuntimeStatus> {
  return collectEventStatus(context(), {
    schemaVersion: 1,
    sequence: 1,
    status: testStatus(),
    autostart: { state: "off", canEnable: true, reason: null },
  });
}

async function untilAbort(signal: AbortSignal): Promise<void> {
  try {
    await pause(60_000, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

async function nextMatching(
  iterator: AsyncGenerator<CliRuntimeStatus>,
  matches: (status: CliRuntimeStatus) => boolean,
): Promise<CliRuntimeStatus> {
  for (let i = 0; i < 64; i++) {
    const result = await iterator.next();
    assert.equal(result.done, false, "watch ended before the expected observation");
    if (result.value && matches(result.value)) return result.value;
  }
  throw new Error("Watch ended before the expected observation");
}

it("does not probe stopped/unhealthy instances and keeps delay failures separate from Core health", async () => {
  const original = await status();
  assert.equal(original.delay, undefined);
  let probes = 0;
  const probe = async () => {
    probes += 1;
    return measurement(12);
  };
  const stopped = { ...original, core: { ...original.core, running: false } };
  const observed = await observeStatusDelay(
    context(),
    stopped,
    "group",
    new AbortController().signal,
    probe,
  );
  assert.equal(observed.state, "unavailable");
  assert.equal(probes, 0);
  const failure = withStatusDelay(original, {
    ...measurement(12),
    state: "timeout",
    delayMs: null,
    error: "No response within 5000ms",
  });
  assert.equal(failure.healthy, true);
  assert.equal(failure.complete, false);
  assert.equal(failure.core, original.core);
  assert.match(failure.queryError ?? "", /Delay test/);
  assert.equal(withStatusDelay(original, measurement(12)).complete, true);
  assert.throws(() => parseCoreDelayResult({ ...measurement(12), name: "another" }, "group"));
  assert.throws(() => parseCoreDelayResult({ ...measurement(12), delayMs: "12" }, "group"));
  assert.deepEqual(parseCoreDelayResult(measurement(12), "group").delayMs, 12);
});

it("coalesces status changes without issuing additional probes", { timeout: 5000 }, async (t) => {
  const original = await status();
  const changes = deferred();
  const cancellation = new AbortController();
  t.after(() => cancellation.abort());
  let probes = 0;
  const iterator = watchStatusWithDelay(context, "group", {
    signal: cancellation.signal,
    statuses: async function* (signal) {
      yield original;
      await changes.promise;
      for (let i = 1; i <= 30; i++)
        yield { ...original, activeProfile: { id: String(i), name: "saved only", url: "" } };
      await untilAbort(signal);
    },
    probe: async () => {
      probes += 1;
      return measurement(12);
    },
  });
  await nextMatching(iterator, (status) => status.delay?.state === "ok");
  changes.resolve();
  const latest = await nextMatching(iterator, (status) => status.activeProfile?.id === "30");
  assert.equal(latest.delay?.delayMs, 12);
  assert.equal(probes, 1);
  cancellation.abort();
  assert.equal((await iterator.next()).done, true);
});

it("samples a quiet watch periodically without overlapping an in-flight probe", {
  timeout: 5000,
}, async (t) => {
  const original = await status();
  const entered = deferred();
  const release = deferred();
  const cancellation = new AbortController();
  t.after(() => {
    cancellation.abort();
    release.resolve();
  });
  let probes = 0;
  const iterator = watchStatusWithDelay(context, "group", {
    signal: cancellation.signal,
    intervalMs: 20,
    statuses: async function* (signal) {
      yield original;
      await untilAbort(signal);
    },
    probe: async () => {
      probes += 1;
      if (probes === 2) {
        entered.resolve();
        await release.promise;
      }
      return measurement(probes * 10);
    },
  });
  await nextMatching(iterator, (status) => status.delay?.state === "ok");
  const updated = iterator.next();
  await entered.promise;
  await pause(60);
  assert.equal(probes, 2);
  release.resolve();
  assert.equal((await updated).value?.delay?.delayMs, 20);
  cancellation.abort();
  assert.equal((await iterator.next()).done, true);
});

it("cancels stale probes on Core replacement and discards their late results", {
  timeout: 5000,
}, async (t) => {
  const original = await status();
  const entered = deferred();
  const replace = deferred();
  const cancellation = new AbortController();
  t.after(() => {
    cancellation.abort();
    replace.resolve();
  });
  let probes = 0;
  let cancelled = false;
  const iterator = watchStatusWithDelay(context, "group", {
    signal: cancellation.signal,
    statuses: async function* (signal) {
      yield original;
      await replace.promise;
      yield { ...original, core: { ...original.core, pid: 4567 } };
      await untilAbort(signal);
    },
    probe: async (_context, _status, _name, signal) => {
      probes += 1;
      if (probes === 1) {
        entered.resolve();
        await untilAbort(signal);
        cancelled = true;
        return measurement(999);
      }
      return measurement(22);
    },
  });
  assert.equal((await iterator.next()).value?.delay?.state, "pending");
  await entered.promise;
  replace.resolve();
  const current = await nextMatching(iterator, (status) => status.delay?.state === "ok");
  assert.equal(current.core.pid, 4567);
  assert.equal(current.delay?.delayMs, 22);
  assert.equal(cancelled, true);
  assert.equal(probes, 2);
  cancellation.abort();
  assert.equal((await iterator.next()).done, true);
});
