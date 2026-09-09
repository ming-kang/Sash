import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { iconComponents, resolveIcon } from "./icons.js";

const expectedNames = [
  "alert",
  "check-circle",
  "clipboard",
  "code",
  "download",
  "eye",
  "eye-off",
  "globe",
  "grid",
  "info",
  "layers",
  "list-filter",
  "loader",
  "monitor",
  "moon",
  "pause",
  "pencil",
  "play",
  "power",
  "refresh",
  "search",
  "settings",
  "sun",
  "swap",
  "terminal",
  "timer",
  "trash",
  "upload",
  "warning",
  "x",
  "zap",
];

describe("Remix Icon mapping", () => {
  it("covers every semantic icon exposed by the WebUI", () => {
    assert.deepEqual(Object.keys(iconComponents).sort(), expectedNames);
  });

  it("uses the fallback only for unknown names", () => {
    assert.equal(resolveIcon("grid"), iconComponents.grid);
    assert.notEqual(resolveIcon("unknown"), iconComponents.grid);
  });
});
