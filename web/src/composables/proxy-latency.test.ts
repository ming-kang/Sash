import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { deferredValue } from "../../../src/testing/state.js";
import { api } from "../api/index.js";
import { store } from "../stores/state.js";
import { toast } from "../stores/toast.js";
import { useProxyLatency } from "./proxy-latency.js";

const originalGroupDelay = api.testGroupDelay;
const originalProxyDelay = api.testProxyDelay;
let originalGeneration = 0;

beforeEach((t) => {
  assert.ok("mock" in t);
  t.mock.method(toast, "success", () => {});
  t.mock.method(toast, "warning", () => {});
  t.mock.method(toast, "error", () => {});
  originalGeneration = store.runtimeGeneration;
  store.proxies = {
    node: { name: "node", type: "Direct", udp: true, history: [] },
  };
  store.manualProxyDelays = {};
});

afterEach(() => {
  api.testGroupDelay = originalGroupDelay;
  api.testProxyDelay = originalProxyDelay;
  store.proxies = {};
  store.manualProxyDelays = {};
  store.runtimeGeneration = originalGeneration;
});

describe("proxy latency ownership", () => {
  it("distinguishes measured timeouts from request failures and preserves the error message", async (t) => {
    const messages: string[] = [];
    t.mock.method(toast, "error", (message: string) => messages.push(message));
    const latency = useProxyLatency();
    api.testProxyDelay = async () => ({ delay: 0 });
    await latency.testSingle("node");
    assert.equal(store.manualProxyDelays.node, 0);
    api.testProxyDelay = async () => {
      throw new Error("connection refused");
    };
    await latency.testSingle("node");
    assert.equal(store.manualProxyDelays.node, "failed");
    assert.match(messages.at(-1) ?? "", /connection refused/);
    api.testProxyDelay = async () => {
      throw new DOMException("deadline", "TimeoutError");
    };
    await latency.testSingle("node");
    assert.equal(store.manualProxyDelays.node, 0);
  });

  it("publishes each group result as soon as its own request settles", async () => {
    store.proxies.fast = { name: "fast", type: "Direct", udp: true, history: [] };
    store.proxies.slow = { name: "slow", type: "Direct", udp: true, history: [] };
    store.proxies.PROXY = {
      name: "PROXY",
      type: "Selector",
      udp: true,
      history: [],
      all: ["fast", "slow"],
    };
    const fast = deferredValue<{ delay: number }>();
    const slow = deferredValue<{ delay: number }>();
    api.testProxyDelay = (name) => (name === "fast" ? fast.promise : slow.promise);
    const latency = useProxyLatency();

    const pending = latency.testGroup("PROXY");
    assert.deepEqual(latency.testingNodes.value, new Set(["fast", "slow"]));
    fast.resolve({ delay: 42 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.manualProxyDelays.fast, 42);
    assert.equal(store.manualProxyDelays.slow, undefined);
    assert.equal(latency.testingNodes.value.has("fast"), false);
    assert.equal(latency.testingNodes.value.has("slow"), true);
    assert.equal(latency.testingGroups.value.has("PROXY"), true);

    slow.reject(new DOMException("deadline", "TimeoutError"));
    await pending;
    assert.equal(store.manualProxyDelays.slow, 0);
    assert.equal(latency.testingNodes.value.size, 0);
    assert.equal(latency.testingGroups.value.has("PROXY"), false);
  });

  it("caps concurrent group requests", async () => {
    const names = Array.from({ length: 10 }, (_, index) => `node-${index}`);
    store.proxies = Object.fromEntries([
      ...names.map((name) => [name, { name, type: "Direct", udp: true, history: [] }]),
      ["PROXY", { name: "PROXY", type: "Selector", udp: true, history: [], all: names }],
    ]);
    const responses = names.map(() => deferredValue<{ delay: number }>());
    let active = 0;
    let peak = 0;
    api.testProxyDelay = async (name) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        const response = responses[names.indexOf(name)];
        assert.ok(response);
        return await response.promise;
      } finally {
        active -= 1;
      }
    };

    const pending = useProxyLatency().testGroup("PROXY");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(peak, 8);
    for (const [index, response] of responses.entries()) response.resolve({ delay: index + 1 });
    await pending;
    assert.equal(peak, 8);
    assert.equal(store.manualProxyDelays["node-9"], 10);
  });

  it("drops a slower single-node result after runtime generation changes", async () => {
    let resolveDelay: ((value: { delay: number }) => void) | undefined;
    api.testProxyDelay = async () =>
      new Promise<{ delay: number }>((resolve) => {
        resolveDelay = resolve;
      });
    const latency = useProxyLatency();

    const pending = latency.testSingle("node");
    assert.equal(latency.testingNodes.value.has("node"), true);
    store.runtimeGeneration += 1;
    resolveDelay?.({ delay: 88 });
    await pending;

    assert.equal(store.manualProxyDelays.node, undefined);
    assert.equal(latency.testingNodes.value.has("node"), false);
  });

  it("measures the node a nested group routes through so both cards update together", async () => {
    store.proxies.jp = { name: "jp", type: "Trojan", udp: true, history: [] };
    store.proxies.Auto = {
      name: "Auto",
      type: "URLTest",
      udp: true,
      history: [],
      all: ["jp"],
      now: "jp",
    };
    store.proxies.PROXY = {
      name: "PROXY",
      type: "Selector",
      udp: true,
      history: [],
      all: ["Auto", "jp", "node"],
      now: "Auto",
    };
    const requested: string[] = [];
    const jp = deferredValue<{ delay: number }>();
    api.testProxyDelay = (name) => {
      requested.push(name);
      return name === "jp" ? jp.promise : Promise.resolve({ delay: 20 });
    };
    const latency = useProxyLatency();

    const single = latency.testSingle("Auto");
    assert.deepEqual(latency.testingNodes.value, new Set(["Auto", "jp"]));
    jp.resolve({ delay: 93 });
    await single;
    assert.deepEqual(requested, ["jp"]);
    assert.equal(store.manualProxyDelays.jp, 93);
    assert.equal(store.manualProxyDelays.Auto, undefined);

    requested.length = 0;
    await latency.testGroup("PROXY");
    assert.deepEqual(requested.sort(), ["jp", "node"]);
    assert.equal(latency.testingNodes.value.size, 0);
  });
});
