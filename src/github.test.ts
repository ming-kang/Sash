import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GITHUB_MIRRORS, METACUBEXD_REPO, MIHOMO_REPO, USER_AGENT } from "./github.js";

describe("github", () => {
  it("defines repository constants", () => {
    assert.equal(MIHOMO_REPO, "MetaCubeX/mihomo");
    assert.equal(METACUBEXD_REPO, "MetaCubeX/metacubexd");
  });

  it("defines GitHub mirrors starting with direct connection (empty string)", () => {
    assert.ok(Array.isArray(GITHUB_MIRRORS));
    assert.ok(GITHUB_MIRRORS.length >= 1);
    assert.equal(GITHUB_MIRRORS[0], "");
    for (const mirror of GITHUB_MIRRORS) {
      assert.equal(typeof mirror, "string");
      if (mirror) {
        assert.ok(mirror.startsWith("https://"));
        assert.ok(mirror.endsWith("/"));
      }
    }
  });

  it("defines USER_AGENT string", () => {
    assert.equal(typeof USER_AGENT, "string");
    assert.ok(USER_AGENT.length > 0);
  });
});
