import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { MockAgent } from "undici";
import { seedGeodataFile } from "./geodata-seed.js";
import { proxyAwareDispatcher } from "./http.js";
import { sashLayout } from "./paths.js";

const LATEST = "/MetaCubeX/meta-rules-dat/releases/latest";
const API_TAGS = "/repos/MetaCubeX/meta-rules-dat/releases/tags";
const DOWNLOAD = "/MetaCubeX/meta-rules-dat/releases/download";

describe("seedGeodataFile", () => {
  let savedManifest: string | undefined;
  let dir: string | undefined;

  function layout() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-geodata-seed-"));
    return sashLayout(dir);
  }

  function mockAgent(t: import("node:test").TestContext): MockAgent {
    const agent = new MockAgent();
    agent.disableNetConnect();
    t.mock.method(proxyAwareDispatcher(), "dispatch", agent.dispatch.bind(agent));
    t.after(() => agent.close());
    return agent;
  }

  afterEach(() => {
    if (savedManifest === undefined) delete process.env.SASH_BOOTSTRAP_MANIFEST;
    else process.env.SASH_BOOTSTRAP_MANIFEST = savedManifest;
    savedManifest = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("downloads a verified database into the data folder from the live API", async (t) => {
    const content = Buffer.from("fake geoip database bytes");
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    const agent = mockAgent(t);
    agent
      .get("https://github.com")
      .intercept({ path: LATEST })
      .reply(302, "", { headers: { location: `${LATEST.replace(/latest$/, "tag/v2026.01")}` } });
    agent
      .get("https://api.github.com")
      .intercept({ path: `${API_TAGS}/v2026.01` })
      .reply(200, {
        assets: [
          {
            name: "geoip.dat",
            browser_download_url: `https://github.com${DOWNLOAD}/v2026.01/geoip.dat`,
            size: content.length,
            digest: `sha256:${digest}`,
          },
        ],
      });
    agent
      .get("https://github.com")
      .intercept({ path: `${DOWNLOAD}/v2026.01/geoip.dat` })
      .reply(200, content);

    const layout_ = layout();
    const result = await seedGeodataFile("geoip.dat", layout_);
    assert.deepEqual(result, { file: "geoip.dat", source: "live" });
    assert.deepEqual(fs.readFileSync(path.join(layout_.root, "geoip.dat")), content);
    agent.assertNoPendingInterceptors();
  });

  it("falls back to the packaged manifest when the release API is unreachable", async (t) => {
    const content = Buffer.from("pinned geosite database bytes");
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    savedManifest = process.env.SASH_BOOTSTRAP_MANIFEST;
    const layout_ = layout();
    const manifestFile = path.join(layout_.root, "manifest.json");
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({
        core: {
          tag: "v9.9.9",
          assets: [{ name: "mihomo-linux-amd64-v9.9.9.gz", size: 1, sha256: "0".repeat(64) }],
        },
        geodata: {
          tag: "v2026.02",
          assets: [{ name: "geosite.dat", size: content.length, sha256: digest }],
        },
      }),
    );
    process.env.SASH_BOOTSTRAP_MANIFEST = manifestFile;

    const agent = mockAgent(t);
    const failure = new Error("getaddrinfo ENOTFOUND api.github.com");
    agent.get("https://github.com").intercept({ path: LATEST }).replyWithError(failure).times(2);
    agent
      .get("https://api.github.com")
      .intercept({ path: "/repos/MetaCubeX/meta-rules-dat/releases/latest" })
      .replyWithError(failure)
      .times(2);
    agent
      .get("https://github.com")
      .intercept({ path: `${DOWNLOAD}/v2026.02/geosite.dat` })
      .reply(200, content);

    const result = await seedGeodataFile("geosite.dat", layout_);
    assert.deepEqual(result, { file: "geosite.dat", source: "pinned" });
    assert.deepEqual(fs.readFileSync(path.join(layout_.root, "geosite.dat")), content);
    agent.assertNoPendingInterceptors();
  });

  it("rejects bytes that do not match the manifest digest", async (t) => {
    savedManifest = process.env.SASH_BOOTSTRAP_MANIFEST;
    const layout_ = layout();
    const manifestFile = path.join(layout_.root, "manifest.json");
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({
        core: {
          tag: "v9.9.9",
          assets: [{ name: "mihomo-linux-amd64-v9.9.9.gz", size: 1, sha256: "0".repeat(64) }],
        },
        geodata: {
          tag: "v2026.02",
          assets: [{ name: "geoip.dat", size: 5, sha256: "f".repeat(64) }],
        },
      }),
    );
    process.env.SASH_BOOTSTRAP_MANIFEST = manifestFile;

    const agent = mockAgent(t);
    const failure = new Error("getaddrinfo ENOTFOUND api.github.com");
    agent.get("https://github.com").intercept({ path: LATEST }).replyWithError(failure).times(2);
    agent
      .get("https://api.github.com")
      .intercept({ path: "/repos/MetaCubeX/meta-rules-dat/releases/latest" })
      .replyWithError(failure)
      .times(2);
    const poisoned = Buffer.from("evil!");
    const directPath = `${DOWNLOAD}/v2026.02/geoip.dat`;
    agent.get("https://github.com").intercept({ path: directPath }).reply(200, poisoned);
    for (const mirror of ["https://ghfast.top", "https://gh-proxy.com"]) {
      agent
        .get(mirror)
        .intercept({ path: `/https://github.com${directPath}` })
        .reply(200, poisoned);
    }

    await assert.rejects(seedGeodataFile("geoip.dat", layout_), /Failed to download and verify/);
    assert.equal(fs.existsSync(path.join(layout_.root, "geoip.dat")), false);
  });

  it("refuses files outside the known geodata set", async () => {
    const layout_ = layout();
    await assert.rejects(
      seedGeodataFile("../../evil", layout_),
      /internal error: refusing to seed unknown geodata file/,
    );
  });
});
