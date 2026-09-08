import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { testStatus } from "../../../src/test-state.test.js";
import { api } from "../api/index.js";
import { closeAllConnections, closeConnection, normalizeConnections } from "./core-actions.js";
import { store } from "./state.js";

describe("web Core actions", () => {
  it("normalizes an empty Core connection snapshot", () => {
    assert.deepEqual(normalizeConnections(null), []);
  });

  for (const all of [false, true])
    it(`does not clear a successor Core's connections (all=${all})`, async (t) => {
      const originalStatus = store.status;
      const originalConnections = store.connections;
      t.after(() => {
        store.status = originalStatus;
        store.connections = originalConnections;
      });
      const pending = Promise.withResolvers<void>();
      t.mock.method(api, all ? "closeAllConnections" : "closeConnection", () => pending.promise);
      store.status = testStatus();
      const closing = all ? closeAllConnections() : closeConnection("new-connection");
      store.status = { ...testStatus(), revisions: { state: 0, runtime: 2 } };
      const successor: typeof store.connections = [
        {
          id: "new-connection",
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
        },
      ];
      store.connections = successor;
      pending.resolve();
      await closing;
      assert.equal(store.connections, successor);
    });
});
