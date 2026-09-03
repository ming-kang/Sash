import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { containsCoreVersionToken } from "./core-version.js";

describe("containsCoreVersionToken", () => {
  it("accepts exact and punctuation-delimited release tokens", () => {
    assert.equal(containsCoreVersionToken("v1.19.30", "v1.19.30"), true);
    assert.equal(containsCoreVersionToken("Mihomo Meta v1.19.30 linux amd64", "v1.19.30"), true);
    assert.equal(containsCoreVersionToken("Mihomo (v1.19.30), ready", "v1.19.30"), true);
  });

  it("rejects prefix, suffix, case, and prerelease collisions", () => {
    assert.equal(containsCoreVersionToken("xv1.19.30", "v1.19.30"), false);
    assert.equal(containsCoreVersionToken("v1.19.30x", "v1.19.30"), false);
    assert.equal(containsCoreVersionToken("v1.19.30-alpha", "v1.19.30"), false);
    assert.equal(containsCoreVersionToken("V1.19.30", "v1.19.30"), false);
  });

  it("treats the expected value literally and considers later occurrences", () => {
    assert.equal(containsCoreVersionToken("v1x2x3", "v1.2.3"), false);
    assert.equal(containsCoreVersionToken("release (v1+2)", "v1+2"), true);
    assert.equal(containsCoreVersionToken("xv1.2.3 then v1.2.3", "v1.2.3"), true);
    assert.equal(containsCoreVersionToken("anything", ""), false);
  });
});
