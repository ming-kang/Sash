import assert from "node:assert/strict";
import { describe, it, onTestFinished, vi } from "vitest";
import { toRaw } from "vue";
import { deferredValue, testStatus } from "../../../src/testing/state.js";
import { api } from "../api/index.js";
import type { ConnectionItem, ProxyItem } from "../types/index.js";
import {
  closeAllConnections,
  closeConnection,
  isProxyGroup,
  normalizeConnections,
  proxyChain,
  proxyDisplayGroups,
  refreshProxies,
  refreshRules,
  resolvedProxyDelay,
  selectGroupProxy,
  setProxies,
} from "./core-actions.js";
import { resetCoreState, store } from "./state.js";

function testConnection(id: string): ConnectionItem {
  return {
    id,
    metadata: {
      network: "tcp",
      type: "HTTP",
      sourceIP: "127.0.0.1",
      destinationIP: "192.0.2.1",
      sourcePort: "40000",
      destinationPort: "443",
      host: "example.test",
    },
    upload: 0,
    download: 0,
    start: "2026-09-08T00:00:00.000Z",
    chains: [],
    rule: "MATCH",
    rulePayload: "",
  };
}

describe("web Core actions", () => {
  for (const fail of [false, true])
    it(`ignores a replaced runtime's pending resource response (failure=${fail})`, async () => {
      const original = { ...store };
      onTestFinished(() => {
        Object.assign(store, original);
      });
      store.status = testStatus();
      const response = deferredValue<Awaited<ReturnType<typeof api.getRules>>>();
      vi.spyOn(api, "getRules").mockImplementation(() => response.promise);
      const refreshing = refreshRules();
      resetCoreState();
      if (fail) response.reject(new Error("old runtime failed"));
      else response.resolve({ rules: [{ type: "MATCH", payload: "", proxy: "old" }] });
      await refreshing;
      assert.deepEqual(store.rules, []);
      assert.deepEqual(store.resourceLoaded, {});
      assert.deepEqual(store.resourceErrors, {});
    });

  it("reuses identical proxy snapshots but honors a local selection and a reset", async () => {
    const original = { ...store };
    onTestFinished(() => {
      Object.assign(store, original);
    });
    store.status = testStatus();
    const proxies = {
      PROXY: { name: "PROXY", type: "Selector", udp: true, history: [], all: ["a", "b"], now: "a" },
    };
    setProxies(proxies);
    const groups = store.proxyGroups;
    setProxies(structuredClone(proxies));
    assert.equal(toRaw(store.proxies), proxies);
    assert.equal(store.proxyGroups, groups);

    vi.spyOn(api, "selectProxy").mockImplementation(async () => {});
    await selectGroupProxy("PROXY", "b");
    assert.equal(store.proxies.PROXY?.now, "b");
    setProxies(structuredClone(proxies));
    assert.equal(store.proxies.PROXY?.now, "a", "server snapshot supersedes the local selection");

    const previous = store.proxies;
    store.proxies = {};
    setProxies(structuredClone(proxies));
    assert.notEqual(store.proxies, previous, "a runtime reset re-adopts identical wire data");

    const current = store.proxies;
    store.resourceErrors = { proxies: "Transient failure" };
    vi.spyOn(api, "getProxies").mockImplementation(async () => ({
      proxies: structuredClone(proxies),
    }));
    await refreshProxies();
    assert.equal(store.proxies, current);
    assert.equal(store.resourceErrors.proxies, undefined, "unchanged success clears the error");
  });

  it("treats any entry with a member list as a group, regardless of type", () => {
    const original = { ...store };
    onTestFinished(() => {
      Object.assign(store, original);
    });
    const proxies = {
      GroupByType: { name: "GroupByType", type: "Fallback", udp: true, history: [] },
      GroupByMembers: {
        name: "GroupByMembers",
        type: "Wireguard",
        udp: true,
        history: [],
        all: ["a"],
      },
      Leaf: { name: "Leaf", type: "Trojan", udp: true, history: [] },
    };
    setProxies(proxies);
    assert.deepEqual(store.proxyGroups, ["GroupByType", "GroupByMembers"]);
    assert.equal(isProxyGroup(proxies.GroupByMembers), true);
    assert.equal(isProxyGroup(proxies.Leaf), false);
    assert.equal(isProxyGroup(undefined), false);
  });

  it("builds the pane's display groups per mode", () => {
    const group = (name: string, type: string): ProxyItem => ({
      name,
      type,
      udp: true,
      history: [],
      all: ["a", "b"],
    });
    const proxies: Record<string, ProxyItem> = {
      Auto: group("Auto", "URLTest"),
      Sel: group("Sel", "Selector"),
      Odd: group("Odd", "Relay"),
      GLOBAL: group("GLOBAL", "Selector"),
      Leaf: { name: "Leaf", type: "Trojan", udp: true, history: [] },
    };
    const groups = ["Auto", "Sel", "Odd", "GLOBAL"];
    const membersOf = (name: string) => [`m-${name}`];

    const rule = proxyDisplayGroups("rule", proxies, groups, membersOf);
    assert.deepEqual(
      rule.map((entry) => entry.name),
      ["Sel", "Auto", "Odd"],
      "selector groups render first; GLOBAL stays hidden in rule mode",
    );
    assert.deepEqual(
      rule.map((entry) => entry.selectable),
      [true, false, false],
    );
    assert.deepEqual(rule[0]?.members, ["m-Sel"]);

    assert.deepEqual(proxyDisplayGroups("global", proxies, groups, membersOf), [
      { name: "GLOBAL", members: ["m-GLOBAL"], selectable: true },
    ]);
    assert.deepEqual(
      proxyDisplayGroups("global", proxies, groups, () => []),
      [],
      "an empty GLOBAL member list collapses to the empty state",
    );
    assert.deepEqual(proxyDisplayGroups("direct", proxies, groups, membersOf), []);
  });

  it("normalizes an empty Core connection snapshot", () => {
    assert.deepEqual(normalizeConnections(null), []);
  });

  for (const all of [false, true])
    it(`drops connections after the Core confirms the close (all=${all})`, async () => {
      const originalStatus = store.status;
      const originalConnections = store.connections;
      onTestFinished(() => {
        store.status = originalStatus;
        store.connections = originalConnections;
      });
      vi.spyOn(api, all ? "closeAllConnections" : "closeConnection").mockImplementation(
        async () => {},
      );
      store.status = testStatus();
      store.connections = [testConnection("one"), testConnection("two")];

      if (all) await closeAllConnections();
      else await closeConnection("one");

      assert.deepEqual(
        store.connections.map((connection) => connection.id),
        all ? [] : ["two"],
      );
    });

  it("resolves a group's delay through its selected chain and survives cycles", () => {
    const original = { ...store };
    onTestFinished(() => {
      Object.assign(store, original);
    });
    const node = (name: string, delay?: number) => ({
      name,
      type: "Trojan",
      udp: true,
      history: delay === undefined ? [] : [{ time: "2026-11-01T00:00:00Z", delay }],
    });
    const group = (name: string, now: string) => ({
      name,
      type: "Selector",
      udp: true,
      history: [],
      all: [now],
      now,
    });
    store.proxies = {
      PROXY: group("PROXY", "Auto"),
      Auto: { ...group("Auto", "jp"), type: "URLTest" },
      jp: node("jp", 93),
      LB: { ...group("LB", ""), type: "LoadBalance", history: [{ time: "", delay: 40 }] },
      A: group("A", "B"),
      B: group("B", "A"),
      Lost: group("Lost", "missing"),
    };
    store.manualProxyDelays = {};
    assert.deepEqual(proxyChain("PROXY"), ["PROXY", "Auto", "jp"]);
    assert.equal(resolvedProxyDelay("PROXY"), 93);
    store.manualProxyDelays = { jp: 0 };
    assert.equal(resolvedProxyDelay("PROXY"), 0);
    assert.equal(resolvedProxyDelay("LB"), 40);
    assert.deepEqual(proxyChain("A"), ["A", "B"]);
    assert.equal(resolvedProxyDelay("A"), undefined);
    store.manualProxyDelays = { Lost: 120 };
    assert.deepEqual(proxyChain("Lost"), ["Lost"]);
    assert.equal(resolvedProxyDelay("Lost"), 120);
  });
});
