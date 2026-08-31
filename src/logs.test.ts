import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeLines } from "./commands/logs.js";

describe("normalizeLines", () => {
  it("keeps positive integers", () => {
    assert.equal(normalizeLines(1), 1);
    assert.equal(normalizeLines(50), 50);
    assert.equal(normalizeLines(9999), 9999);
  });

  it("falls back for invalid input", () => {
    for (const bad of [Number.NaN, 0, -5, Infinity, -Infinity, 3.14, "100", null, undefined, {}]) {
      assert.equal(normalizeLines(bad), 50, JSON.stringify(bad));
    }
  });

  it("honours a custom fallback", () => {
    assert.equal(normalizeLines(Number.NaN, 10), 10);
    assert.equal(normalizeLines(5, 10), 5);
  });
});
