import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeConnections } from "./core-actions.js";

describe("web Core actions", () => {
  it("normalizes an empty Core connection snapshot", () => {
    assert.deepEqual(normalizeConnections(null), []);
  });
});
