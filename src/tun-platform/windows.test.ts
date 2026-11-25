import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { MockAgent } from "undici";
import { afterEach, describe, it, onTestFinished, vi } from "vitest";
import { GITHUB_MIRRORS } from "../github.js";
import { proxyAwareDispatcher } from "../http.js";
import { readSashPackageInfo } from "../package-info.js";
import { sashLayout } from "../paths.js";
import {
  HELPER_PROTOCOL,
  HELPER_REPO,
  type HelperOp,
  type HelperReply,
  helperAssetName,
  installScript,
  privilegeFromReply,
  quoteWindowsArgument,
  requestHelper,
  resolveHelperSource,
  serviceArguments,
  uninstallScript,
  windowsTunPlatform,
} from "./windows.js";

const layout = sashLayout("C:\\Users\\Dev User\\AppData\\Local\\Sash");

function reply(patch: Partial<HelperReply> = {}): HelperReply {
  return { ok: true, protocol: HELPER_PROTOCOL, home: layout.root, running: false, ...patch };
}

describe("Windows helper arguments", () => {
  it("quotes like CommandLineToArgvW expects", () => {
    assert.equal(quoteWindowsArgument("service"), "service");
    assert.equal(quoteWindowsArgument("C:\\Program Files\\x"), '"C:\\Program Files\\x"');
    assert.equal(quoteWindowsArgument("C:\\a b\\"), '"C:\\a b\\\\"');
    assert.equal(quoteWindowsArgument('say "hi"'), '"say \\"hi\\""');
    assert.equal(quoteWindowsArgument(""), '""');
  });

  it("fixes the Core, data folder, logs and account at installation", () => {
    assert.equal(
      serviceArguments(layout, "S-1-5-21-1-2-3-1001"),
      [
        "service --user S-1-5-21-1-2-3-1001",
        `--core "${layout.coreExe}"`,
        `--home "${layout.root}"`,
        `--config "${layout.configFile}"`,
        `--stdout "${layout.coreLogFile}"`,
        `--stderr "${layout.coreErrLogFile}"`,
      ].join(" "),
    );
    assert.equal(helperAssetName("arm64"), "sash-tun-helper-win32-arm64.exe");
  });
});

describe("Windows elevated scripts", () => {
  it("verify the copied helper inside the protected directory before registering it", () => {
    const script = installScript({
      source: "C:\\Users\\o'neil\\AppData\\Local\\Sash\\temp\\sash-tun-helper-win32-x64.exe",
      sha256: "a".repeat(64),
      arguments: "service --user S-1-5-21-1",
    });
    assert.match(script, /'C:\\Users\\o''neil\\AppData/);
    const protect = script.indexOf("Protect-Directory $dir }");
    const copy = script.indexOf("Copy-Item");
    const hash = script.indexOf("Get-FileHash -LiteralPath $helperExe");
    const register = script.indexOf("New-Service");
    assert.ok(protect > 0 && protect < copy && copy < hash && hash < register);
    assert.match(script, /icacls\.exe \$dir \/setowner '\*S-1-5-32-544'/);
    assert.match(script, /-StartupType Automatic/);
  });

  it("replace the 0.7.0 helper service on install and uninstall", () => {
    for (const script of [
      installScript({ source: "s", sha256: "b", arguments: "a" }),
      uninstallScript(),
    ]) {
      assert.match(script, /Remove-SashService 'SashTun'/);
      assert.match(script, /Remove-SashService 'SashTunHelper'/);
      assert.match(script, /\$legacyDir = Join-Path \$sashDir 'core'/);
    }
  });
});

describe("Windows helper state", () => {
  it("is ready only for this data folder and protocol", () => {
    assert.deepEqual(privilegeFromReply(reply(), layout), { state: "ready" });
    assert.deepEqual(privilegeFromReply(reply({ home: layout.root.toUpperCase() }), layout), {
      state: "ready",
    });
    assert.equal(privilegeFromReply(reply({ home: "D:\\Other" }), layout).state, "stale");
    assert.equal(
      privilegeFromReply(reply({ protocol: HELPER_PROTOCOL + 1 }), layout).state,
      "stale",
    );
  });

  it("tells a missing service from a stopped or legacy one", async () => {
    const unreachable = async (): Promise<HelperReply> => {
      throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
    };
    const inspect = (registered: string[]) =>
      windowsTunPlatform({
        request: unreachable,
        serviceRegistered: async (name) => registered.includes(name),
      }).inspect(layout);
    assert.deepEqual(await inspect([]), { state: "missing" });
    assert.equal((await inspect(["SashTun"])).state, "stale");
    assert.match((await inspect(["SashTunHelper"])).detail ?? "", /0\.7\.0/);
  });

  it("hosts a Core only for its own data folder", async () => {
    const calls: HelperOp[] = [];
    let home = layout.root;
    const host = windowsTunPlatform({
      request: async (op) => {
        calls.push(op);
        return reply({ home, running: op === "start", ...(op === "start" ? { pid: 77 } : {}) });
      },
    }).host?.(layout);
    assert.ok(host);
    assert.deepEqual(await host.start(), { pid: 77 });
    assert.deepEqual(calls, ["status", "start"]);
    home = "D:\\Other";
    await assert.rejects(host.start(), /cannot start this Core/);
    assert.deepEqual(calls, ["status", "start", "status"]);
  });
});

describe("requestHelper", () => {
  it.skipIf(process.platform !== "win32")("exchanges one JSON line over the pipe", async () => {
    const pipe = `\\\\.\\pipe\\sash-tun-test-${process.pid}-${Date.now()}`;
    const seen: string[] = [];
    const server = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        seen.push(chunk.toString());
        socket.end(`${JSON.stringify(reply({ running: true, pid: 9 }))}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    assert.deepEqual(await requestHelper("status", 2_000, pipe), reply({ running: true, pid: 9 }));
    assert.deepEqual(seen, ['{"op":"status"}\n']);
  });

  it("fails fast when nothing listens", async () => {
    const pipe =
      process.platform === "win32"
        ? `\\\\.\\pipe\\sash-tun-missing-${process.pid}`
        : path.join(os.tmpdir(), `sash-tun-missing-${process.pid}.sock`);
    await assert.rejects(requestHelper("status", 2_000, pipe), /ENOENT|ECONNREFUSED/);
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
