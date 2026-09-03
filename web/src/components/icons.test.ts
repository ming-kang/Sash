import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { iconComponents, resolveIcon } from "./icons.js";

const expectedNames = [
  "alert",
  "check-circle",
  "clipboard",
  "download",
  "edit",
  "eye",
  "eye-off",
  "globe",
  "grid",
  "info",
  "layers",
  "list-filter",
  "monitor",
  "moon",
  "pause",
  "play",
  "power",
  "refresh",
  "search",
  "settings",
  "speed",
  "sun",
  "swap",
  "terminal",
  "timer",
  "trash",
  "upload",
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
