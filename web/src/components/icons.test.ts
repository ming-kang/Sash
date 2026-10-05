import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { iconComponents, resolveIcon } from "./icons.js";

describe("Remix Icon mapping", () => {
  it("uses the fallback only for unknown names", () => {
    assert.equal(resolveIcon("grid"), iconComponents.grid);
    assert.notEqual(resolveIcon("unknown"), iconComponents.grid);
  });
});
