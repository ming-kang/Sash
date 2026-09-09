import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
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

  it("does not keep a stale success when the group response omits a member", async () => {
    store.proxies.PROXY = {
      name: "PROXY",
      type: "Selector",
      udp: true,
      history: [],
      all: ["node"],
    };
    store.manualProxyDelays.node = 42;
    api.testGroupDelay = async () => ({});
    await useProxyLatency().testGroup("PROXY");
    assert.equal(store.manualProxyDelays.node, "failed");
  });

  it("applies group delays to the captured current runtime", async () => {
    api.testGroupDelay = async () => ({ node: 42 });
    const latency = useProxyLatency();

    await latency.testGroup("PROXY");

    assert.equal(store.manualProxyDelays.node, 42);
    assert.equal(latency.testingGroups.value.has("PROXY"), false);
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
});
