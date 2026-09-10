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

interface FakeTimer {
  id: number;
  callback: () => void;
  delay: number;
  cleared: boolean;
}

function installFakeDom() {
  let nextId = 1;
  const timers: FakeTimer[] = [];
  const visibilityListeners: Array<() => void> = [];
  const hashListeners: Array<() => void> = [];
  const fakeDocument = {
    hidden: false,
    addEventListener: (type: string, listener: () => void) => {
      if (type === "visibilitychange") visibilityListeners.push(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      const list = type === "visibilitychange" ? visibilityListeners : [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    },
  };
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
    removeEventListener: (type: string, listener: () => void) => {
      const list = type === "hashchange" ? hashListeners : [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  return {
    timers,
    visibilityListeners,
    hashListeners,
    latestTimer(): FakeTimer {
      const timer = timers.at(-1);
      assert.ok(timer, "expected a scheduled timer");
      return timer;
    },
    setHidden(hidden: boolean): void {
      fakeDocument.hidden = hidden;
      for (const listener of [...visibilityListeners]) listener();
    },
    restore(): void {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
      else Reflect.deleteProperty(globalThis, "document");
    },
  };
}

type FakeDom = ReturnType<typeof installFakeDom>;

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
    const steps: Step[] = [];
    let waiting: (() => void) | null = null;
    const poke = () => {
      waiting?.();
      waiting = null;
    };
    streams.push({
      signal,
      send: (status) => {
        steps.push({ kind: "event", status });
        poke();
      },
      fail: (error) => {
        steps.push({ kind: "error", error });
        poke();
      },
      end: () => {
        steps.push({ kind: "end" });
        poke();
      },
    });
    return (async function* (): AsyncGenerator<DaemonEvent> {
      for (let index = 0; ; index += 1) {
        while (index >= steps.length) {
          if (signal.aborted) return;
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          if (signal.aborted) return;
        }
        const step = steps[index] as Step;
        if (step.kind === "end") return;
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
let dom: FakeDom;
let disconnected: number;
let resourceReads: Record<"configs" | "proxies" | "rules" | "connections", number>;

beforeEach(() => {
  dom = installFakeDom();
  disconnected = 0;
  resourceReads = { configs: 0, proxies: 0, rules: 0, connections: 0 };
  api.initialize = async () => ({
    token: "health",
    pid: 100,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
  api.hasSession = () => true;
  api.sessionMatches = () => true;
  api.isInitialized = () => true;
  api.markDisconnected = () => {
    disconnected += 1;
  };
  api.getSessionGeneration = () => 1;
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
      assert.equal(dom.timers[0]?.delay, INTERVAL_MS, "visible page polls at the given interval");
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

  it("marks the daemon offline and reconnects with backoff after the stream closes", async () => {
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
      assert.equal(retry.delay, 2000, "first retry uses exponential backoff");

      retry.callback();
      await flush();
      assert.equal(channel.streams.length, 2, "the retry resubscribes");

      channel.streams[1]?.end();
      await flush();
      assert.equal(dom.latestTimer().delay, 4000, "backoff grows with repeated failures");
    } finally {
      stop();
    }
  });

  it("treats a 401 as a public daemon and retries slowly without a session", async () => {
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
      assert.equal(dom.latestTimer().delay, 15_000, "session-less polls back off further");
    } finally {
      stop();
    }
  });

  it("polls hidden pages slowly and forces a refresh when the page becomes visible", async () => {
    const channel = eventChannel();
    api.events = channel.factory;
    const stop = startRuntimeEvents(INTERVAL_MS);
    try {
      await flush();
      channel.streams[0]?.send(runtimeStatus(0));
      await flush();
      assert.deepEqual(resourceReads, { configs: 1, proxies: 1, rules: 0, connections: 1 });
      const visibleTimer = dom.timers[0] as FakeTimer;

      dom.setHidden(true);
      visibleTimer.callback();
      await flush();
      assert.equal(dom.latestTimer().delay, 15_000, "hidden pages poll slowly");
      assert.deepEqual(resourceReads, { configs: 1, proxies: 1, rules: 0, connections: 1 });

      dom.setHidden(false);
      await flush();
      assert.deepEqual(resourceReads, { configs: 2, proxies: 2, rules: 0, connections: 2 });
    } finally {
      stop();
    }
  });

  it("reconnects immediately when the page becomes visible without a stream", async () => {
    const channel = eventChannel();
    api.events = channel.factory;
    const stop = startRuntimeEvents(INTERVAL_MS);
    try {
      await flush();
      channel.streams[0]?.end();
      await flush();
      assert.equal(dom.latestTimer().delay, 2000);
      assert.equal(channel.streams.length, 1);

      dom.setHidden(true);
      dom.setHidden(false);
      await flush();
      assert.equal(dom.latestTimer().delay, 0, "visibility restore reconnects immediately");
      dom.latestTimer().callback();
      await flush();
      assert.equal(channel.streams.length, 2);
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

  it("stop() aborts the stream, clears timers, and detaches listeners", async () => {
    const channel = eventChannel();
    api.events = channel.factory;
    const stop = startRuntimeEvents(INTERVAL_MS);
    await flush();
    assert.equal(channel.streams.length, 1);
    const resourceTimer = dom.timers[0] as FakeTimer;
    const timerCount = dom.timers.length;
    assert.equal(dom.visibilityListeners.length, 1);
    assert.equal(dom.hashListeners.length, 1);

    stop();
    assert.equal(channel.streams[0]?.signal.aborted, true);
    assert.equal(resourceTimer.cleared, true);
    assert.equal(dom.visibilityListeners.length, 0);
    assert.equal(dom.hashListeners.length, 0);

    channel.streams[0]?.send(runtimeStatus(0));
    resourceTimer.callback();
    dom.setHidden(false);
    await flush();
    assert.equal(store.status, null, "no snapshots are adopted after stop");
    assert.equal(dom.timers.length, timerCount, "no timers are rescheduled after stop");
    stop();
  });
});
