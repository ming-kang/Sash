import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBrowserSpawnOptions } from "./browser.js";

describe("browser child environment", () => {
  it("scrubs credentials while preserving ordinary launcher environment", () => {
    const options = buildBrowserSpawnOptions({
      PATH: "/bin",
      HOME: "/home/test",
      GH_TOKEN: "github-secret",
      NODE_AUTH_TOKEN: "npm-secret",
      npm_config__auth: "registry-secret",
    });

    assert.equal(options.detached, true);
    assert.equal(options.stdio, "ignore");
    assert.equal(options.env?.PATH, "/bin");
    assert.equal(options.env?.HOME, "/home/test");
    assert.equal(options.env?.GH_TOKEN, undefined);
    assert.equal(options.env?.NODE_AUTH_TOKEN, undefined);
    assert.equal(options.env?.npm_config__auth, undefined);
  });
});
