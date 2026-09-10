import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockAgent } from "undici";
import {
  GITHUB_DOWNLOAD_HOSTS,
  GITHUB_MIRRORS,
  listReleaseAssets,
  MIHOMO_REPO,
  parseSha256Digest,
  resolveLatestTag,
  USER_AGENT,
} from "./github.js";
import { ERROR_BODY_LIMIT, proxyAwareDispatcher } from "./http.js";

describe("github", () => {
  it("preserves AbortError without falling back to another release endpoint", async (t) => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    t.mock.method(proxyAwareDispatcher(), "dispatch", agent.dispatch.bind(agent));
    t.after(() => agent.close());
    const error = new DOMException("cancelled release lookup", "AbortError");
    agent
      .get("https://github.com")
      .intercept({ path: "/example/project/releases/latest" })
      .replyWithError(error)
      .times(2);
    agent
      .get("https://api.github.com")
      .intercept({ path: "/repos/example/project/releases/latest" })
      .reply(200, { tag_name: "v1.0.0" });
    await assert.rejects(resolveLatestTag("example/project"), { name: "AbortError" });
    assert.equal(agent.pendingInterceptors().length, 1, "the fallback must remain unused");
  });

  it("reports the HTTP status when release error bodies exceed the read limit", async (t) => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    t.mock.method(proxyAwareDispatcher(), "dispatch", agent.dispatch.bind(agent));
    t.after(() => agent.close());
    agent
      .get("https://github.com")
      .intercept({ path: "/example/project/releases/latest" })
      .reply(200, "not a redirect");
    const api = agent.get("https://api.github.com");
    api
      .intercept({ path: "/repos/example/project/releases/latest" })
      .reply(403, "x".repeat(ERROR_BODY_LIMIT + 1));
    api
      .intercept({ path: "/repos/example/project/releases/tags/v1.0.0" })
      .reply(404, "x".repeat(ERROR_BODY_LIMIT + 1));
    await assert.rejects(resolveLatestTag("example/project"), /HTTP 403/);
    await assert.rejects(listReleaseAssets("example/project", "v1.0.0"), /HTTP 404/);
  });

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
});
