import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAutostartStatus } from "./autostart-contract.js";
import { SashClient } from "./sash-client.js";

describe("autostart response contract", () => {
  it("rejects malformed and misleading state responses", async () => {
    for (const value of [
      null,
      {},
      { state: true, canEnable: true, reason: null },
      { state: "off", canEnable: "true", reason: null },
      { state: "off", canEnable: true },
      { state: "off", canEnable: true, reason: null, command: "unexpected" },
    ]) {
      assert.throws(() => parseAutostartStatus(value), /Invalid autostart status/);
    }
    const client = new SashClient({
      baseUrl: "",
      fetchFn: async () => ({ status: 200, text: async () => '{"enabled":true}' }),
    });
    await assert.rejects(client.autostartStatus(), /Invalid autostart status/);
    await assert.rejects(client.setAutostart(true), /Invalid autostart status/);
  });
});
