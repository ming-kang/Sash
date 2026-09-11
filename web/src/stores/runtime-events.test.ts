import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { nextTick } from "vue";
import { SashApiError } from "../../../src/sash-client.js";
import type { DaemonEvent } from "../../../src/sash-events.js";
import { testProfile, testStatus } from "../../../src/testing/state.js";
import { api } from "../api/index.js";
import { currentRoute } from "../router.js";
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
  const hashListeners: Array<() => void> = [];
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
    addEventListener: (type: string, listener: () => void) => {
      if (type === "hashchange") hashListeners.push(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      const index = hashListeners.indexOf(listener);
      if (index >= 0) hashListeners.splice(index, 1);
    },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  return {
    timers,
    hashListeners,
    latestTimer(): FakeTimer {
      const timer = timers.at(-1);
      assert.ok(timer, "expected a scheduled timer");
      return timer;
    },
    triggerHashChange(): void {
      for (const listener of [...hashListeners]) listener();
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

/** api.events factory whose streams the test drives explicitly. */
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
let disconnected: number;
let resourceReads: Record<"configs" | "proxies" | "rules" | "connections", number>;

beforeEach(() => {
  dom = installFakeWindow();
  disconnected = 0;
  resourceReads = { configs: 0, proxies: 0, rules: 0, connections: 0 };
  api.initialize = async () => ({
    token: "health",
    pid: 100,
    startedAt: "2026-01-01T00:00:00.000Z",
    version: "1.2.3",
  });
  api.hasSession = () => true;
  api.sessionMatches = () => true;
  api.isInitialized = () => true;
  api.markDisconnected = () => {
    disconnected += 1;
  };
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
  disconnected = 0;
  currentRoute.value = "overview";
  store.profiles = [];
  store.lastStateRevision = null;
  store.resourceLoaded = {};
  store.resourceErrors = {};
});

afterEach(() => {
  markDaemonOffline();
  Object.assign(api, originalApi);
  dom.restore();
  currentRoute.value = "overview";
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
      assert.equal(store.status, status, "snapshot adopted into the store");
      assert.equal(store.daemonOnline, true);
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
      assert.equal(store.daemonOnline, true);

      channel.streams[0]?.end();
      await flush();
      assert.equal(store.daemonOnline, false, "a closed stream degrades the daemon");
      assert.equal(store.status, null);
      assert.equal(disconnected, 1);
      const retry = dom.latestTimer();
      assert.equal(retry.delay, RECONNECT_MS, "reconnect waits one fixed interval");

      retry.callback();
      await flush();
      assert.equal(channel.streams.length, 2, "the retry resubscribes");
    } finally {
      stop();
    }
  });

  it("treats a 401 as a public daemon and retries without a session", async () => {
    const channel = eventChannel();
    api.events = channel.factory;
    let session = true;
    api.hasSession = () => session;
    const stop = startRuntimeEvents(INTERVAL_MS);
    try {
      await flush();
      channel.streams[0]?.send(runtimeStatus(0));
      await flush();
      assert.equal(store.resourceLoaded.configs, true);

      session = false;
      channel.streams[0]?.fail(new SashApiError(401, "unauthorized", "session expired"));
      await flush();
      assert.equal(store.daemonOnline, true, "a 401 keeps the public daemon reachable");
      assert.equal(disconnected, 0, "a 401 is not a disconnect");
      assert.deepEqual(store.resourceLoaded, {}, "core-owned state is released");
      assert.equal(dom.latestTimer().delay, RECONNECT_MS);
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

      currentRoute.value = "rules";
      await nextTick();
      await flush();
      assert.equal(resourceReads.rules, 1, "rules load for the rules page");
      assert.deepEqual(resourceReads, { configs: 1, proxies: 1, rules: 1, connections: 1 });
    } finally {
      stop();
    }
  });

  it("reconnects immediately when a new authorization handoff arrives", async () => {
    const channel = eventChannel();
    api.events = channel.factory;
    const stop = startRuntimeEvents(INTERVAL_MS);
    try {
      await flush();
      const first = channel.streams[0];
      dom.triggerHashChange();
      await flush();
      assert.equal(first?.signal.aborted, false, "an initialized page ignores hash changes");
      assert.equal(channel.streams.length, 1);

      api.isInitialized = () => false;
      dom.triggerHashChange();
      await flush();
      assert.equal(first?.signal.aborted, true);
      const retry = dom.latestTimer();
      assert.equal(retry.delay, 0, "a handoff reconnects immediately");
      retry.callback();
      await flush();
      assert.equal(channel.streams.length, 2);
    } finally {
      stop();
    }
  });

  it("stop() aborts the stream, clears timers, and detaches listeners", async () => {
    const channel = eventChannel();
    api.events = channel.factory;
    const stop = startRuntimeEvents(INTERVAL_MS);
    await flush();
    assert.equal(channel.streams.length, 1);
    const resourceTimer = dom.timers[0] as FakeTimer;
    const timerCount = dom.timers.length;
    assert.equal(dom.hashListeners.length, 1);

    stop();
    assert.equal(channel.streams[0]?.signal.aborted, true);
    assert.equal(resourceTimer.cleared, true);
    assert.equal(dom.hashListeners.length, 0);

    channel.streams[0]?.send(runtimeStatus(0));
    resourceTimer.callback();
    await flush();
    assert.equal(store.status, null, "no snapshots are adopted after stop");
    assert.equal(dom.timers.length, timerCount, "no timers are rescheduled after stop");
    stop();
  });
});
