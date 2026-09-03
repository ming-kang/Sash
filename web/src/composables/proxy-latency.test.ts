import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { api } from "../api/index.js";
import { store } from "../stores/state.js";
import { useProxyLatency } from "./proxy-latency.js";

const originalGroupDelay = api.testGroupDelay;
const originalProxyDelay = api.testProxyDelay;
let originalGeneration = 0;

beforeEach(() => {
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
