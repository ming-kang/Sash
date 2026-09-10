import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAutostartStatus } from "./autostart-contract.js";

describe("autostart response contract", () => {
  it("rejects malformed and misleading state responses", () => {
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
  });
});
