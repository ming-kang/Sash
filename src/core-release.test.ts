import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

describe("resolveCoreRelease manifest fallback", () => {
  let savedCoreVersion: string | undefined;
  let savedManifest: string | undefined;
  let manifestDir: string | undefined;

  function writeManifest(coreTag: string): void {
    manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-manifest-fallback-"));
    fs.writeFileSync(
      path.join(manifestDir, "bootstrap-manifest.json"),
      JSON.stringify({
        core: {
          tag: coreTag,
          assets: [
            {
              name: `mihomo-linux-amd64-${coreTag}.gz`,
              size: 1024,
              sha256: "1".repeat(64),
            },
          ],
        },
        geodata: {
          tag: "latest",
          assets: [{ name: "geoip.dat", size: 4096, sha256: "2".repeat(64) }],
        },
      }),
    );
    process.env.SASH_BOOTSTRAP_MANIFEST = path.join(manifestDir, "bootstrap-manifest.json");
  }

  function mockApiDown(t: import("node:test").TestContext): MockAgent {
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
    return agent;
  }

  afterEach(() => {
    if (savedCoreVersion === undefined) delete process.env.SASH_CORE_VERSION;
    else process.env.SASH_CORE_VERSION = savedCoreVersion;
    savedCoreVersion = undefined;
    if (savedManifest === undefined) delete process.env.SASH_BOOTSTRAP_MANIFEST;
    else process.env.SASH_BOOTSTRAP_MANIFEST = savedManifest;
    savedManifest = undefined;
    if (manifestDir) fs.rmSync(manifestDir, { recursive: true, force: true });
    manifestDir = undefined;
  });

  it("falls back to the packaged manifest when the release API is unreachable", async (t) => {
    savedCoreVersion = process.env.SASH_CORE_VERSION;
    delete process.env.SASH_CORE_VERSION;
    savedManifest = process.env.SASH_BOOTSTRAP_MANIFEST;
    writeManifest("v9.9.9");
    const agent = mockApiDown(t);
    const resolved = await resolveCoreRelease();
    assert.equal(resolved.tag, "v9.9.9");
    assert.equal(resolved.source, "pinned");
    assert.deepEqual(
      resolved.assets.map((asset) => asset.name),
      ["mihomo-linux-amd64-v9.9.9.gz"],
    );
    assert.equal(resolved.assets[0]?.digest, `sha256:${"1".repeat(64)}`);
    agent.assertNoPendingInterceptors();
  });

  it("serves an explicit pin matching the manifest tag without the live API", async (t) => {
    savedCoreVersion = process.env.SASH_CORE_VERSION;
    delete process.env.SASH_CORE_VERSION;
    savedManifest = process.env.SASH_BOOTSTRAP_MANIFEST;
    writeManifest("v9.9.9");
    const agent = new MockAgent();
    agent.disableNetConnect();
    t.mock.method(proxyAwareDispatcher(), "dispatch", agent.dispatch.bind(agent));
    t.after(() => agent.close());
    const failure = new Error("getaddrinfo ENOTFOUND api.github.com");
    agent
      .get("https://api.github.com")
      .intercept({ path: `${API_TAGS}/v9.9.9` })
      .replyWithError(failure)
      .times(2);
    const resolved = await resolveCoreRelease({ tag: "v9.9.9" });
    assert.equal(resolved.tag, "v9.9.9");
    assert.equal(resolved.source, "pinned");
  });

  it("refuses to substitute the manifest for a different pinned tag", async (t) => {
    savedCoreVersion = process.env.SASH_CORE_VERSION;
    delete process.env.SASH_CORE_VERSION;
    savedManifest = process.env.SASH_BOOTSTRAP_MANIFEST;
    writeManifest("v9.9.9");
    const failure = new Error("getaddrinfo ENOTFOUND api.github.com");
    const agent = new MockAgent();
    agent.disableNetConnect();
    t.mock.method(proxyAwareDispatcher(), "dispatch", agent.dispatch.bind(agent));
    t.after(() => agent.close());
    agent
      .get("https://api.github.com")
      .intercept({ path: `${API_TAGS}/v1.0.0` })
      .replyWithError(failure)
      .times(2);
    await assert.rejects(resolveCoreRelease({ tag: "v1.0.0" }), /cannot reach GitHub/);
  });

  it("still reports the offline guidance when no manifest is packaged", async (t) => {
    savedCoreVersion = process.env.SASH_CORE_VERSION;
    delete process.env.SASH_CORE_VERSION;
    savedManifest = process.env.SASH_BOOTSTRAP_MANIFEST;
    delete process.env.SASH_BOOTSTRAP_MANIFEST;
    mockApiDown(t);
    await assert.rejects(resolveCoreRelease(), /cannot reach GitHub/);
  });

  it("marks live resolutions as live", async (t) => {
    savedCoreVersion = process.env.SASH_CORE_VERSION;
    process.env.SASH_CORE_VERSION = "v9.9.9";
    savedManifest = process.env.SASH_BOOTSTRAP_MANIFEST;
    writeManifest("v0.0.1");
    const agent = new MockAgent();
    agent.disableNetConnect();
    t.mock.method(proxyAwareDispatcher(), "dispatch", agent.dispatch.bind(agent));
    t.after(() => agent.close());
    agent
      .get("https://api.github.com")
      .intercept({ path: `${API_TAGS}/v9.9.9` })
      .reply(200, oneAsset("v9.9.9"));
    const resolved = await resolveCoreRelease();
    assert.equal(resolved.source, "live");
  });
});

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
