import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { nextTick, toRaw } from "vue";
import { SashApiError } from "../../../src/sash-client.js";
import type { DaemonEvent } from "../../../src/sash-events.js";
import { testProfile, testStatus } from "../../../src/testing/state.js";
import { api } from "../api/index.js";
import { router } from "../router.js";
import type { SashStatus } from "../types/index.js";
import { markDaemonOffline } from "./runtime-actions.js";
import { startRuntimeEvents } from "./runtime-events.js";
import { store } from "./state.js";

const INTERVAL_MS = 2000;
const RECONNECT_MS = 2000;

interface FakeTimer {
  id: number;
  callback: () => void;
  delay: number;
  cleared: boolean;
}

function installFakeWindow() {
  let nextId = 1;
  const timers: FakeTimer[] = [];
  const fakeWindow = {
    setTimeout: (callback: () => void, delay: number): number => {
      const timer: FakeTimer = { id: nextId, callback, delay, cleared: false };
      nextId += 1;
      timers.push(timer);
      return timer.id;
    },
    clearTimeout: (id: number) => {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) timer.cleared = true;
    },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  return {
    timers,
    latestTimer(): FakeTimer {
      const timer = timers.at(-1);
      assert.ok(timer, "expected a scheduled timer");
      return timer;
    },
    restore(): void {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}

type FakeWindow = ReturnType<typeof installFakeWindow>;

interface EventStream {
  signal: AbortSignal;
  send(status: SashStatus): void;
  fail(error: unknown): void;
  end(): void;
}

function daemonEvent(status: SashStatus): DaemonEvent {
  return {
    schemaVersion: 1,
    sequence: 1,
    status,
    autostart: { state: "off", canEnable: true, reason: null },
  };
}

function eventChannel() {
  const streams: EventStream[] = [];
  const factory = (signal: AbortSignal): AsyncGenerator<DaemonEvent> => {
    type Step =
      | { kind: "event"; status: SashStatus }
      | { kind: "error"; error: unknown }
      | { kind: "end" };
    const queue: Step[] = [];
    let wake: (() => void) | null = null;
    const push = (step: Step) => {
      queue.push(step);
      wake?.();
      wake = null;
    };
    streams.push({
      signal,
      send: (status) => push({ kind: "event", status }),
      fail: (error) => push({ kind: "error", error }),
      end: () => push({ kind: "end" }),
    });
    return (async function* (): AsyncGenerator<DaemonEvent> {
      while (!signal.aborted) {
        if (!queue.length)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        if (signal.aborted) return;
        const step = queue.shift();
        if (!step || step.kind === "end") return;
        if (step.kind === "error") throw step.error;
        yield daemonEvent(step.status);
      }
    })();
  };
  return { streams, factory };
}

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function runtimeStatus(stateRevision: number): SashStatus {
  const status = testStatus();
  status.revisions.state = stateRevision;
  status.core.running = true;
  status.core.healthy = true;
  return status;
}

const originalApi = { ...api };
let dom: FakeWindow;
let resourceReads: Record<"configs" | "proxies" | "rules" | "connections", number>;

beforeEach(async () => {
  dom = installFakeWindow();
  resourceReads = { configs: 0, proxies: 0, rules: 0, connections: 0 };
  api.getProfiles = async () => ({ activeId: null, profiles: [] });
  api.getConfigs = async () => {
    resourceReads.configs += 1;
    return { mode: "rule" } as Awaited<ReturnType<typeof api.getConfigs>>;
  };
  api.getProxies = async () => {
    resourceReads.proxies += 1;
    return { proxies: {} };
  };
  api.getRules = async () => {
    resourceReads.rules += 1;
    return { rules: [] };
  };
  api.getConnections = async () => {
    resourceReads.connections += 1;
    return { connections: null, uploadTotal: 0, downloadTotal: 0 };
  };
  markDaemonOffline();
  await router.push({ name: "overview" });
  store.profiles = [];
  store.lastStateRevision = null;
  store.resourceLoaded = {};
  store.resourceErrors = {};
});

afterEach(async () => {
  markDaemonOffline();
  Object.assign(api, originalApi);
  dom.restore();
  await router.push({ name: "overview" });
});

describe("runtime event subscription", () => {
  it("connects, adopts pushed snapshots, and refreshes visible resources", async () => {
    const channel = eventChannel();
    api.events = channel.factory;
    const profile = testProfile();
    api.getProfiles = async () => ({ activeId: profile.id, profiles: [profile] });
    const stop = startRuntimeEvents(INTERVAL_MS);
    try {
      await flush();
      assert.equal(channel.streams.length, 1, "event stream subscribed");
      assert.notEqual(store.connection, "connected", "control waits for the first live snapshot");
      assert.equal(dom.timers.length, 1, "only the resource poll is scheduled");
      assert.equal(
        dom.timers[0]?.delay,
        INTERVAL_MS,
        "the visible page polls at the given interval",
      );
      assert.deepEqual(resourceReads, { configs: 0, proxies: 0, rules: 0, connections: 0 });

      const status = runtimeStatus(3);
      channel.streams[0]?.send(status);
      await flush();
      assert.equal(toRaw(store.status), status, "snapshot adopted into the store");
      assert.equal(store.connection, "connected");
      assert.equal(store.lastStateRevision, 3);
      assert.deepEqual(store.profiles, [profile], "state revision refresh loads profiles");
      assert.deepEqual(resourceReads, { configs: 1, proxies: 1, rules: 0, connections: 1 });
      assert.deepEqual(store.resourceLoaded, { configs: true, proxies: true, connections: true });
    } finally {
      stop();
    }
  });

  it("marks the daemon offline and reconnects after the stream closes", async () => {
    const channel = eventChannel();
    api.events = channel.factory;
    const stop = startRuntimeEvents(INTERVAL_MS);
    try {
      await flush();
      channel.streams[0]?.send(runtimeStatus(0));
      await flush();
      assert.equal(store.connection, "connected");

      channel.streams[0]?.end();
      await flush();
      assert.equal(store.connection, "offline", "a closed stream degrades the daemon");
      assert.equal(store.status, null);
      const retry = dom.latestTimer();
      assert.equal(retry.delay, RECONNECT_MS, "reconnect waits one fixed interval");

      retry.callback();
      await flush();
      assert.equal(channel.streams.length, 2, "the retry resubscribes");
    } finally {
      stop();
    }
  });

  it("treats a 401 as a refusal of this page and keeps retrying", async () => {
    const channel = eventChannel();
    api.events = channel.factory;
    const stop = startRuntimeEvents(INTERVAL_MS);
    try {
      await flush();
      channel.streams[0]?.send(runtimeStatus(0));
      await flush();
      assert.equal(store.resourceLoaded.configs, true);

      channel.streams[0]?.fail(new SashApiError(401, "unauthorized", "foreign origin"));
      await flush();
      assert.equal(store.connection, "refused", "a 401 is a refusal, not a disconnect");
      assert.deepEqual(store.resourceLoaded, {}, "core-owned state is released");
      const retry = dom.latestTimer();
      assert.equal(retry.delay, RECONNECT_MS);

      retry.callback();
      await flush();
      channel.streams[1]?.fail(new SashApiError(401, "unauthorized", "foreign origin"));
      await flush();
      assert.equal(store.connection, "refused", "repeated refusals never flicker to connected");
    } finally {
      stop();
    }
  });

  it("refreshes the newly visible resources on route changes", async () => {
    const channel = eventChannel();
    api.events = channel.factory;
    const stop = startRuntimeEvents(INTERVAL_MS);
    try {
      await flush();
      channel.streams[0]?.send(runtimeStatus(0));
      await flush();
      assert.equal(resourceReads.rules, 0);

      await router.push({ name: "rules" });
      await nextTick();
      await flush();
      assert.equal(resourceReads.rules, 1, "rules load for the rules page");
      assert.deepEqual(resourceReads, { configs: 1, proxies: 1, rules: 1, connections: 1 });
    } finally {
      stop();
    }
  });

  it("stop() aborts the stream and clears timers", async () => {
    const channel = eventChannel();
    api.events = channel.factory;
    const stop = startRuntimeEvents(INTERVAL_MS);
    await flush();
    assert.equal(channel.streams.length, 1);
    const resourceTimer = dom.timers[0] as FakeTimer;
    const timerCount = dom.timers.length;

    stop();
    assert.equal(channel.streams[0]?.signal.aborted, true);
    assert.equal(resourceTimer.cleared, true);

    channel.streams[0]?.send(runtimeStatus(0));
    resourceTimer.callback();
    await flush();
    assert.equal(store.status, null, "no snapshots are adopted after stop");
    assert.equal(dom.timers.length, timerCount, "no timers are rescheduled after stop");
    stop();
  });
});
