import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  GITHUB_DOWNLOAD_HOSTS,
  GITHUB_MIRRORS,
  MIHOMO_REPO,
  parseSha256Digest,
  sha256File,
  USER_AGENT,
} from "./github.js";

describe("github", () => {
  it("defines repository constants", () => {
    assert.equal(MIHOMO_REPO, "MetaCubeX/mihomo");
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

  it("allows only GitHub release and configured mirror hosts for downloads", () => {
    assert.ok(GITHUB_DOWNLOAD_HOSTS.has("github.com"));
    assert.ok(GITHUB_DOWNLOAD_HOSTS.has("release-assets.githubusercontent.com"));
    for (const mirror of GITHUB_MIRRORS.filter(Boolean)) {
      assert.ok(GITHUB_DOWNLOAD_HOSTS.has(new URL(mirror).hostname));
    }
  });

  it("defines USER_AGENT string", () => {
    assert.equal(typeof USER_AGENT, "string");
    assert.ok(USER_AGENT.length > 0);
  });

  it("parses only canonical SHA-256 release digests", () => {
    const digest = "a".repeat(64);
    assert.equal(parseSha256Digest(`sha256:${digest}`), digest);
    assert.equal(parseSha256Digest(`sha256:${digest.toUpperCase()}`), digest);
    assert.throws(() => parseSha256Digest(digest), /invalid SHA-256 digest/);
    assert.throws(() => parseSha256Digest("sha256:abcd"), /invalid SHA-256 digest/);
  });

  it("computes release file SHA-256 without buffering the whole asset", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-github-digest-test-"));
    const file = path.join(root, "asset.bin");
    try {
      fs.writeFileSync(file, "verified release bytes");
      assert.equal(
        await sha256File(file),
        "783559651bb22d0eda76ae7f87c7a7d3f91264cf5d8f20c4bb5238bce5d20234",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
