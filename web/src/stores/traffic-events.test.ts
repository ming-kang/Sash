import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Window as HappyWindow } from "happy-dom";
import { nextTick } from "vue";
import { testStatus } from "../../../src/testing/state.js";
import { api, sessionReady } from "../api/index.js";
import type { TrafficMessage } from "../types/index.js";
import { store } from "./state.js";
import { startTrafficEvents } from "./traffic-events.js";

interface TrafficSocket {
  send(message: TrafficMessage): void;
  closed: boolean;
}

const originalApi = api.connectTraffic;
const originalSessionReady = sessionReady.value;
const originalStore = {
  status: store.status,
  daemonOnline: store.daemonOnline,
  traffic: store.traffic,
};
const globalKeys = ["window", "document"] as const;
const previousGlobals = new Map<string, { existed: boolean; value: unknown }>();
let dom: HappyWindow;
let sockets: TrafficSocket[];
let stopTraffic: (() => void) | null;

function setHidden(hidden: boolean): void {
  Object.defineProperty(dom.document, "hidden", { configurable: true, value: hidden });
  dom.document.dispatchEvent(new dom.Event("visibilitychange"));
}

beforeEach(() => {
  dom = new HappyWindow({ url: "http://127.0.0.1:19090/ui/" });
  for (const key of globalKeys) {
    previousGlobals.set(key, {
      existed: Object.hasOwn(globalThis, key),
      value: Reflect.get(globalThis, key),
    });
    Reflect.set(globalThis, key, Reflect.get(dom, key));
  }
  sockets = [];
  stopTraffic = null;
  store.status = testStatus();
  store.status.core.running = true;
  store.status.core.healthy = true;
  store.daemonOnline = true;
  sessionReady.value = true;
  api.connectTraffic = (onData) => {
    const socket: TrafficSocket = { send: onData, closed: false };
    sockets.push(socket);
    return () => {
      socket.closed = true;
    };
  };
});

afterEach(async () => {
  stopTraffic?.();
  api.connectTraffic = originalApi;
  sessionReady.value = originalSessionReady;
  store.status = originalStore.status;
  store.daemonOnline = originalStore.daemonOnline;
  store.traffic = originalStore.traffic;
  await dom.close();
  for (const key of globalKeys) {
    const saved = previousGlobals.get(key);
    if (saved?.existed) Reflect.set(globalThis, key, saved.value);
    else Reflect.deleteProperty(globalThis, key);
  }
  previousGlobals.clear();
});

describe("traffic event subscription", () => {
  it("keeps one stream and appends history across tab visibility changes", async () => {
    stopTraffic = startTrafficEvents(0);
    assert.equal(sockets.length, 1);
    const socket = sockets[0];
    assert.ok(socket);

    socket.send({ up: 100, down: 1000 });
    const visibleHistory = store.traffic.historyDown;
    setHidden(true);
    await nextTick();
    assert.equal(socket.closed, false, "hiding does not close the traffic socket");
    assert.equal(sockets.length, 1, "hiding does not create a replacement socket");
    assert.equal(store.traffic.historyDown, visibleHistory, "hiding does not clear history");

    socket.send({ up: 200, down: 4000 });
    assert.equal(store.traffic.up, 200);
    assert.equal(store.traffic.down, 4000);
    assert.equal(store.traffic.historyDown.at(-2), 1000);
    assert.equal(store.traffic.historyDown.at(-1), 4000);

    setHidden(false);
    await nextTick();
    socket.send({ up: 300, down: 2000 });
    assert.equal(sockets.length, 1, "returning to the tab reuses the same stream");
    assert.ok(store.traffic.historyDown.includes(4000), "the background peak survives");
    assert.equal(store.traffic.historyDown.at(-1), 2000);
  });

  it("coalesces visible bursts and discards a pending rate on disconnect", async () => {
    let disconnect = () => {};
    api.connectTraffic = (onData, onDisconnect) => {
      const socket: TrafficSocket = { send: onData, closed: false };
      sockets.push(socket);
      disconnect = () => onDisconnect?.();
      return () => {
        socket.closed = true;
      };
    };
    stopTraffic = startTrafficEvents(20);
    const socket = sockets[0];
    assert.ok(socket);

    socket.send({ up: 100, down: 1000 });
    socket.send({ up: 200, down: 2000 });
    socket.send({ up: 300, down: 3000 });
    assert.equal(store.traffic.up, 0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(store.traffic.up, 300);
    assert.equal(store.traffic.historyUp.at(-1), 300);
    assert.equal(store.traffic.historyUp.at(-2), 0);

    socket.send({ up: 400, down: 4000 });
    disconnect();
    assert.equal(store.traffic.up, 0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(store.traffic.up, 0);
    assert.equal(store.traffic.historyUp.at(-1), 300);
  });

  it("still releases the stream and history when the Core becomes unhealthy", async () => {
    stopTraffic = startTrafficEvents(0);
    const socket = sockets[0];
    assert.ok(socket);
    socket.send({ up: 100, down: 1000 });

    const status = testStatus();
    status.core.running = true;
    status.core.healthy = false;
    store.status = status;
    await nextTick();

    assert.equal(socket.closed, true);
    assert.equal(store.traffic.up, 0);
    assert.ok(store.traffic.historyDown.every((value) => value === 0));
  });
});
