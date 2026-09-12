import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { MockAgent } from "undici";
import { OFFLINE_CORE_INSTALL_URL, resolveCoreRelease } from "./core.js";
import { proxyAwareDispatcher } from "./http.js";

const LATEST = "/MetaCubeX/mihomo/releases/latest";
const API_LATEST = "/repos/MetaCubeX/mihomo/releases/latest";
const API_TAGS = "/repos/MetaCubeX/mihomo/releases/tags";

function oneAsset(tag: string) {
  return {
    assets: [
      {
        name: `mihomo-linux-amd64-${tag}.gz`,
        browser_download_url: `https://github.com/MetaCubeX/mihomo/releases/download/${tag}/mihomo-linux-amd64-${tag}.gz`,
        size: 1024,
        digest: `sha256:${"1".repeat(64)}`,
      },
    ],
  };
}

describe("resolveCoreRelease failure guidance", () => {
  let savedCoreVersion: string | undefined;

  afterEach(() => {
    if (savedCoreVersion === undefined) delete process.env.SASH_CORE_VERSION;
    else process.env.SASH_CORE_VERSION = savedCoreVersion;
    savedCoreVersion = undefined;
  });

  it("points rate-limited release lookups at GITHUB_TOKEN", async (t) => {
    savedCoreVersion = process.env.SASH_CORE_VERSION;
    delete process.env.SASH_CORE_VERSION;
    const agent = new MockAgent();
    agent.disableNetConnect();
    t.mock.method(proxyAwareDispatcher(), "dispatch", agent.dispatch.bind(agent));
    t.after(() => agent.close());
    agent.get("https://github.com").intercept({ path: LATEST }).reply(200, "not a redirect");
    agent.get("https://api.github.com").intercept({ path: API_LATEST }).reply(403, "rate limited");
    await assert.rejects(
      resolveCoreRelease(),
      /HTTP 403 — the GitHub API rate limit was reached; set GITHUB_TOKEN and retry/,
    );
  });

  it("points plain network failures at a proxy or the manual installation", async (t) => {
    savedCoreVersion = process.env.SASH_CORE_VERSION;
    delete process.env.SASH_CORE_VERSION;
    const agent = new MockAgent();
    agent.disableNetConnect();
    t.mock.method(proxyAwareDispatcher(), "dispatch", agent.dispatch.bind(agent));
    t.after(() => agent.close());
    const failure = new Error("getaddrinfo ENOTFOUND github.com");
    agent.get("https://github.com").intercept({ path: LATEST }).replyWithError(failure).times(2);
    agent
      .get("https://api.github.com")
      .intercept({ path: API_LATEST })
      .replyWithError(failure)
      .times(2);
    await assert.rejects(resolveCoreRelease(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /— cannot reach GitHub; set HTTP_PROXY to a running proxy, or install Core manually:/,
      );
      assert.ok(error.message.includes(OFFLINE_CORE_INSTALL_URL));
      return true;
    });
  });

  it("leaves proxy-refused remedies alone", async (t) => {
    savedCoreVersion = process.env.SASH_CORE_VERSION;
    delete process.env.SASH_CORE_VERSION;
    const agent = new MockAgent();
    agent.disableNetConnect();
    t.mock.method(proxyAwareDispatcher(), "dispatch", agent.dispatch.bind(agent));
    t.after(() => agent.close());
    const refused = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      address: "10.0.0.1",
      port: 8080,
    });
    agent.get("https://github.com").intercept({ path: LATEST }).replyWithError(refused).times(2);
    agent
      .get("https://api.github.com")
      .intercept({ path: API_LATEST })
      .replyWithError(refused)
      .times(2);
    await assert.rejects(resolveCoreRelease(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "proxy 10.0.0.1:8080 refused connection — check HTTP_PROXY");
      return true;
    });
  });

  it("pins the tag from SASH_CORE_VERSION and skips the latest lookup", async (t) => {
    savedCoreVersion = process.env.SASH_CORE_VERSION;
    process.env.SASH_CORE_VERSION = "v9.9.9";
    const agent = new MockAgent();
    agent.disableNetConnect();
    t.mock.method(proxyAwareDispatcher(), "dispatch", agent.dispatch.bind(agent));
    t.after(() => agent.close());
    // No github.com intercept: any latest lookup fails this test on its own.
    agent
      .get("https://api.github.com")
      .intercept({ path: `${API_TAGS}/v9.9.9` })
      .reply(200, oneAsset("v9.9.9"));
    const resolved = await resolveCoreRelease();
    assert.equal(resolved.tag, "v9.9.9");
    agent.assertNoPendingInterceptors();
  });

  it("rejects an invalid SASH_CORE_VERSION without network guidance", async (t) => {
    savedCoreVersion = process.env.SASH_CORE_VERSION;
    process.env.SASH_CORE_VERSION = "not a tag!";
    const agent = new MockAgent();
    agent.disableNetConnect();
    t.mock.method(proxyAwareDispatcher(), "dispatch", agent.dispatch.bind(agent));
    t.after(() => agent.close());
    await assert.rejects(resolveCoreRelease(), /^Error: Invalid Core release tag: not a tag!$/);
  });
});
