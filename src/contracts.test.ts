import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseApiErrorBody } from "./contracts.js";

describe("shared API boundaries", () => {
  it("extracts the daemon's error code and message from an error body", () => {
    assert.deepEqual(parseApiErrorBody({ error: { code: "conflict", message: "changed" } }), {
      code: "conflict",
      message: "changed",
    });
    for (const value of ["invalid", null, {}, { error: {} }, { error: { code: "conflict" } }]) {
      assert.equal(parseApiErrorBody(value), undefined);
    }
  });
});
