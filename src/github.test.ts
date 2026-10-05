import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockAgent } from "undici";
import { listReleaseAssets, parseSha256Digest, resolveLatestTag } from "./github.js";
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

  it("parses only canonical SHA-256 release digests", () => {
    const digest = "a".repeat(64);
    assert.equal(parseSha256Digest(`sha256:${digest}`), digest);
    assert.equal(parseSha256Digest(`sha256:${digest.toUpperCase()}`), digest);
    assert.throws(() => parseSha256Digest(digest), /invalid SHA-256 digest/);
    assert.throws(() => parseSha256Digest("sha256:abcd"), /invalid SHA-256 digest/);
  });
});
