import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildUpgradeSpawnOptions, validateUpgradeVersion } from "./upgrade.js";

describe("upgrade package target", () => {
  it("accepts strict semver and safe dist-tags", () => {
    assert.equal(validateUpgradeVersion("1.2.3"), "1.2.3");
    assert.equal(validateUpgradeVersion("1.2.3-beta.1+build.5"), "1.2.3-beta.1+build.5");
    assert.equal(validateUpgradeVersion("1.2.3-0A"), "1.2.3-0A");
    assert.equal(validateUpgradeVersion("latest"), "latest");
    assert.equal(validateUpgradeVersion("next-release"), "next-release");
  });

  it("rejects package specs, paths, controls, ranges, and v-prefixed versions", () => {
    for (const value of [
      "v1.2.3",
      "@scope/package",
      "file:../package",
      "../package",
      "1.2.x",
      "^1.2.3",
      "latest@evil",
      "bad\ntag",
      " latest",
    ]) {
      assert.throws(
        () => validateUpgradeVersion(value),
        /Invalid Sash package version or dist-tag/,
      );
    }
  });

  it("scrubs registry and GitHub credentials from the npm child environment", () => {
    const options = buildUpgradeSpawnOptions({
      PATH: "/bin",
      GITHUB_TOKEN: "github-secret",
      NPM_TOKEN: "npm-secret",
      npm_config_registry: "https://registry.npmjs.org/",
      npm_config_authToken: "registry-secret",
    });

    assert.equal(options.env?.PATH, "/bin");
    assert.equal(options.env?.npm_config_registry, "https://registry.npmjs.org/");
    assert.equal(options.env?.GITHUB_TOKEN, undefined);
    assert.equal(options.env?.NPM_TOKEN, undefined);
    assert.equal(options.env?.npm_config_authToken, undefined);
  });
});
