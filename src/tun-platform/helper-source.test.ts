import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockAgent } from "undici";
import { afterEach, describe, it, onTestFinished, vi } from "vitest";
import { GITHUB_MIRRORS } from "../github.js";
import { proxyAwareDispatcher } from "../http.js";
import { readSashPackageInfo } from "../package-info.js";
import { sashLayout } from "../paths.js";
import { HELPER_REPO, helperAssetName, resolveHelperSource } from "./helper-source.js";

describe("helperAssetName", () => {
  it("names the asset for the architecture", () => {
    assert.equal(helperAssetName("arm64"), "sash-tun-helper-win32-arm64.exe");
  });
});

describe("resolveHelperSource", () => {
  const { version } = readSashPackageInfo();
  const tag = `v${version}`;
  const name = helperAssetName();
  const apiPath = `/repos/${HELPER_REPO}/releases/tags/${tag}`;
  const downloadPath = `/${HELPER_REPO}/releases/download/${tag}/${name}`;
  const downloadUrl = `https://github.com${downloadPath}`;

  let savedDigestsEnv: string | undefined;
  let tempDir: string | undefined;

  function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  function fixture(bytes: Buffer): {
    layoutRoot: string;
    packageRoot: string;
    digestsFile: string;
  } {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-helper-source-"));
    const layoutRoot = path.join(tempDir, "data");
    const packageRoot = path.join(tempDir, "package");
    fs.mkdirSync(packageRoot, { recursive: true });
    const digestsFile = path.join(tempDir, "digests.json");
    fs.writeFileSync(
      digestsFile,
      JSON.stringify({
        version,
        assets: [{ name, size: bytes.length, sha256: sha256(bytes) }],
      }),
    );
    process.env.SASH_TUN_HELPER_DIGESTS = digestsFile;
    return { layoutRoot, packageRoot, digestsFile };
  }

  function mockAgent(): MockAgent {
    const agent = new MockAgent();
    agent.disableNetConnect();
    vi.spyOn(proxyAwareDispatcher(), "dispatch").mockImplementation(agent.dispatch.bind(agent));
    onTestFinished(() => agent.close());
    return agent;
  }

  function mockDownloads(agent: MockAgent, bytes: Buffer): void {
    agent.get("https://github.com").intercept({ path: downloadPath }).reply(200, bytes);
    for (const mirror of GITHUB_MIRRORS.filter(Boolean)) {
      const mirrored = new URL(`${mirror}${downloadUrl}`);
      agent.get(mirrored.origin).intercept({ path: mirrored.pathname }).reply(200, bytes);
    }
  }

  afterEach(() => {
    if (savedDigestsEnv === undefined) delete process.env.SASH_TUN_HELPER_DIGESTS;
    else process.env.SASH_TUN_HELPER_DIGESTS = savedDigestsEnv;
    savedDigestsEnv = undefined;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("falls back to the embedded digest when the release API is rate-limited", async () => {
    savedDigestsEnv = process.env.SASH_TUN_HELPER_DIGESTS;
    const bytes = Buffer.from(`sash test helper ${process.pid}`);
    const { layoutRoot, packageRoot } = fixture(bytes);
    const agent = mockAgent();
    agent.get("https://api.github.com").intercept({ path: apiPath }).reply(403, "rate limited");
    mockDownloads(agent, bytes);

    const source = await resolveHelperSource(sashLayout(layoutRoot), { packageRoot });
    assert.equal(source.sha256, sha256(bytes));
    assert.deepEqual(fs.readFileSync(source.file), bytes);
    assert.equal(path.basename(source.file), name);
    await source.cleanup();
    assert.equal(fs.existsSync(source.file), false);
  });

  it("rejects the fallback download when the bytes do not match the embedded digest", async () => {
    savedDigestsEnv = process.env.SASH_TUN_HELPER_DIGESTS;
    const { layoutRoot, packageRoot } = fixture(Buffer.from("the real helper"));
    const agent = mockAgent();
    agent.get("https://api.github.com").intercept({ path: apiPath }).reply(403, "rate limited");
    mockDownloads(agent, Buffer.from("a tampered helper"));

    const layout = sashLayout(layoutRoot);
    await assert.rejects(
      resolveHelperSource(layout, { packageRoot }),
      /Failed to download and verify .*SHA-256 mismatch/,
    );
    assert.equal(fs.existsSync(path.join(layout.tempDir, name)), false);
  });

  it("fails clearly when the API is down and no digest is embedded", async () => {
    savedDigestsEnv = process.env.SASH_TUN_HELPER_DIGESTS;
    const { layoutRoot, packageRoot, digestsFile } = fixture(Buffer.from("unused"));
    process.env.SASH_TUN_HELPER_DIGESTS = `${digestsFile}.missing`;
    const agent = mockAgent();
    agent.get("https://api.github.com").intercept({ path: apiPath }).reply(403, "rate limited");

    await assert.rejects(resolveHelperSource(sashLayout(layoutRoot), { packageRoot }), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Could not read the Sash .+ GitHub Release: .+HTTP 403/);
      assert.match(error.message, new RegExp(`no embedded digest for ${name.replace(".", "\\.")}`));
      return true;
    });
  });

  it("prefers the release API digest over the embedded one", async () => {
    savedDigestsEnv = process.env.SASH_TUN_HELPER_DIGESTS;
    const { layoutRoot, packageRoot } = fixture(Buffer.from("embedded helper bytes"));
    const apiBytes = Buffer.from("api helper bytes");
    const agent = mockAgent();
    agent
      .get("https://api.github.com")
      .intercept({ path: apiPath })
      .reply(200, {
        assets: [{ name, size: apiBytes.length, digest: `sha256:${sha256(apiBytes)}` }],
      });
    mockDownloads(agent, apiBytes);

    const source = await resolveHelperSource(sashLayout(layoutRoot), { packageRoot });
    assert.equal(source.sha256, sha256(apiBytes));
    assert.deepEqual(fs.readFileSync(source.file), apiBytes);
    await source.cleanup();
  });

  it("uses a source checkout's own helper build without any download", async () => {
    savedDigestsEnv = process.env.SASH_TUN_HELPER_DIGESTS;
    const { layoutRoot, packageRoot } = fixture(Buffer.from("unused"));
    const bytes = Buffer.from("locally built helper");
    const local = path.join(packageRoot, "helper", "bin", name);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, bytes);
    mockAgent();

    const source = await resolveHelperSource(sashLayout(layoutRoot), { packageRoot });
    assert.equal(source.file, local);
    assert.equal(source.sha256, sha256(bytes));
    await source.cleanup();
    assert.equal(fs.existsSync(local), true, "the local build is never cleaned up");
  });
});
