import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { testStatus } from "../../../src/testing/state.js";
import { api } from "../api/index.js";
import type { ConnectionItem } from "../types/index.js";
import {
  closeAllConnections,
  closeConnection,
  normalizeConnections,
  refreshProxies,
  selectGroupProxy,
  setProxies,
} from "./core-actions.js";
import { store } from "./state.js";

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
  it("reuses identical proxy snapshots but honors a local selection and a reset", async (t) => {
    const original = { ...store };
    t.after(() => Object.assign(store, original));
    store.status = testStatus();
    const proxies = {
      PROXY: { name: "PROXY", type: "Selector", udp: true, history: [], all: ["a", "b"], now: "a" },
    };
    setProxies(proxies);
    const groups = store.proxyGroups;
    setProxies(structuredClone(proxies));
    assert.equal(store.proxies, proxies);
    assert.equal(store.proxyGroups, groups);

    t.mock.method(api, "selectProxy", async () => {});
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
    t.mock.method(api, "getProxies", async () => ({ proxies: structuredClone(proxies) }));
    await refreshProxies();
    assert.equal(store.proxies, current);
    assert.equal(store.resourceErrors.proxies, undefined, "unchanged success clears the error");
  });

  it("normalizes an empty Core connection snapshot", () => {
    assert.deepEqual(normalizeConnections(null), []);
  });

  for (const all of [false, true])
    it(`drops connections after the Core confirms the close (all=${all})`, async (t) => {
      const originalStatus = store.status;
      const originalConnections = store.connections;
      t.after(() => {
        store.status = originalStatus;
        store.connections = originalConnections;
      });
      t.mock.method(api, all ? "closeAllConnections" : "closeConnection", async () => {});
      store.status = testStatus();
      store.connections = [testConnection("one"), testConnection("two")];

      if (all) await closeAllConnections();
      else await closeConnection("one");

      assert.deepEqual(
        store.connections.map((connection) => connection.id),
        all ? [] : ["two"],
      );
    });
});
