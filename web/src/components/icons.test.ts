import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { iconComponents, resolveIcon } from "./icons.js";

describe("Remix Icon mapping", () => {
  it("uses the fallback only for unknown names", () => {
    assert.notEqual(resolveIcon("unknown"), iconComponents.grid);
  });
});
