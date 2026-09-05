import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parsePublicServiceStatus } from "../contracts.js";
import { SashClient } from "../sash-client.js";
import { installService } from "../service-management.js";
import { runServiceInstall, runServiceStatus, runServiceUninstall } from "./service.js";
import { runtimeContext } from "./shared.js";
import { runUpdate } from "./update.js";

let root: string;
let previous: string | undefined;
let originalLog: typeof console.log;
let output: string[];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-service-cli-"));
  previous = process.env.SASH_HOME;
  process.env.SASH_HOME = root;
  originalLog = console.log;
  output = [];
  console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
});
afterEach(() => {
  console.log = originalLog;
  if (previous === undefined) delete process.env.SASH_HOME;
  else process.env.SASH_HOME = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("service CLI and public contract", () => {
  it("strictly parses states, flags, optional strings and projects private fields away", () => {
    for (const state of [
      "not-installed",
      "ready",
      "unavailable",
      "incompatible",
      "root-mismatch",
    ]) {
      assert.deepEqual(
        parsePublicServiceStatus({ supported: true, state, root: "private", secret: "private" }),
        { supported: true, state },
      );
    }
    for (const value of [
      null,
      {},
      { supported: 1, state: "ready" },
      { supported: true, state: "running" },
      { supported: true, state: "ready", version: null },
      { supported: true, state: "ready", coreVersion: 1 },
      { supported: true, state: "ready", message: false },
    ]) {
      assert.throws(() => parsePublicServiceStatus(value), TypeError);
    }
  });
  it("uses the typed read-only client endpoint", async () => {
    const client = new SashClient({
      baseUrl: "http://127.0.0.1:29192",
      fetchFn: async (url, init) => {
        assert.equal(url, "http://127.0.0.1:29192/sash/service");
        assert.equal(init.method, "GET");
        return {
          status: 200,
          text: async () => JSON.stringify({ supported: true, state: "ready" }),
        };
      },
    });
    assert.deepEqual(await client.serviceStatus(), { supported: true, state: "ready" });
  });
  it("maps only documented install options and recommends an ordinary user daemon", async () => {
    runtimeContext(); // Ordinary-user initialization, before mocked administration.
    await runServiceInstall(
      { coreVersion: "v1.2.3", helper: "C:\buildsash-service.exe" },
      {
        platform: "win32",
        installService: async (ctx, opts) => {
          assert.equal(ctx.layout.root, fs.realpathSync(root));
          assert.deepEqual(opts, { coreVersion: "v1.2.3", helperPath: "C:\buildsash-service.exe" });
        },
      },
    );
    assert.match(output.join("\n"), /ordinary PowerShell.*sash start/);
    await runServiceUninstall({
      platform: "win32",
      uninstallService: async (ctx) => {
        assert.equal(ctx.layout.root, fs.realpathSync(root));
      },
    });
  });
  it("missing install/uninstall roots never create files or invoke management", async () => {
    const home = path.join(root, "missing");
    process.env.SASH_HOME = home;
    const deps = {
      platform: "win32" as const,
      installService: async () => assert.fail("native install"),
      uninstallService: async () => assert.fail("native uninstall"),
    };
    await assert.rejects(
      runServiceInstall({}, deps),
      /sash status.*ordinary PowerShell.*same SASH_HOME/,
    );
    await assert.rejects(runServiceUninstall(deps), /sash status.*ordinary PowerShell/);
    assert.equal(fs.existsSync(home), false);
    assert.deepEqual(fs.readdirSync(root), []);
  });
  it("uninitialized existing roots are not modified", async () => {
    await assert.rejects(
      runServiceInstall(
        {},
        {
          platform: "win32",
          installService: async () => assert.fail("native install"),
        },
      ),
      /existing initialized user root/,
    );
    assert.deepEqual(fs.readdirSync(root), []);
  });
  it("foreign-owner rejection preserves settings and creates no administrative files", async () => {
    const ctx = runtimeContext();
    const before = fs.readFileSync(ctx.layout.settingsFile, "utf8");
    fs.rmSync(ctx.layout.stateDir, { recursive: true, force: true });
    await assert.rejects(
      runServiceInstall(
        {},
        {
          platform: "win32",
          installService: (current, opts) =>
            installService(current, opts, {
              platform: "win32",
              bootstrapPrivileges: () => ({ elevated: true, ownerMatches: false }),
              runHelper: async () => assert.fail("native helper"),
            }),
        },
      ),
      /same Windows user/,
    );
    assert.equal(fs.readFileSync(ctx.layout.settingsFile, "utf8"), before);
    assert.deepEqual(fs.readdirSync(root), ["sash.json"]);
  });
  it("preserves unsupported-platform errors without initializing a root", async () => {
    process.env.SASH_HOME = path.join(root, "missing");
    for (const platform of ["linux", "darwin"] as const) {
      await assert.rejects(runServiceInstall({}, { platform }), /supported only on Windows/);
      await assert.rejects(runServiceUninstall({ platform }), /supported only on Windows/);
    }
    assert.deepEqual(fs.readdirSync(root), []);
  });
  it("service status leaves a missing root absent", async () => {
    const home = path.join(root, "missing");
    process.env.SASH_HOME = home;
    await runServiceStatus(
      { json: true },
      {
        serviceStatus: async (layout) => {
          assert.equal(layout.root, home);
          return { supported: true, state: "not-installed" };
        },
      },
    );
    assert.equal(fs.existsSync(home), false);
  });
  it("invalid settings are never rewritten before administrative ownership checks", async () => {
    const file = path.join(root, "sash.json");
    for (const contents of ["{}", "{ broken"]) {
      fs.writeFileSync(file, contents);
      await assert.rejects(
        runServiceInstall(
          {},
          {
            platform: "win32",
            installService: async () => assert.fail("native install"),
          },
        ),
        /ordinary PowerShell/,
      );
      assert.equal(fs.readFileSync(file, "utf8"), contents);
      assert.deepEqual(fs.readdirSync(root), ["sash.json"]);
    }
  });
  it("status JSON does not load or create settings", async () => {
    await runServiceStatus(
      { json: true },
      { serviceStatus: async () => ({ supported: false, state: "not-installed" }) },
    );
    assert(output[0]);
    assert.deepEqual(JSON.parse(output[0]), { supported: false, state: "not-installed" });
    assert.deepEqual(fs.readdirSync(root), []);
  });
  it("routes Windows installed updates to administrative service refresh only", async () => {
    let called = false;
    await runUpdate(
      { version: "v1.2.3", force: true },
      {
        platform: "win32",
        serviceStatus: async () => ({ supported: true, state: "ready" }),
        updateServiceCore: async (_ctx, opts) => {
          called = true;
          assert.deepEqual(opts, { version: "v1.2.3" });
        },
        runCoreUpdate: async () => assert.fail("direct update"),
      },
    );
    assert(called);
  });
  it("fails closed for uncertain service discovery", async () => {
    for (const state of ["unavailable", "incompatible", "root-mismatch"] as const) {
      await assert.rejects(
        runUpdate(
          {},
          {
            platform: "win32",
            serviceStatus: async () => ({ supported: true, state }),
            runCoreUpdate: async () => assert.fail("direct update"),
            updateServiceCore: async () => assert.fail("service update"),
          },
        ),
        /refusing a direct Core update/,
      );
    }
  });
  it("retains direct updates only for absent service or POSIX", async () => {
    for (const platform of ["win32", "darwin"] as const) {
      let called = false;
      await runUpdate(
        {},
        {
          platform,
          serviceStatus: async () => ({ supported: true, state: "not-installed" }),
          runCoreUpdate: async () => {
            called = true;
          },
          updateServiceCore: async () => assert.fail("service update"),
        },
      );
      assert(called);
    }
  });
  it("rejects temporary tun and arbitrary native commands without touching the data directory", () => {
    const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
    const home = path.join(root, "untouched");
    for (const args of [
      ["--help"],
      ["service", "install", "--help"],
      ["tun", "on"],
      ["service", "bridge"],
      ["service", "install", "extra"],
      ["service", "install", "--root", "other"],
      ["service", "install", "--helper"],
      ["service", "status", "extra"],
    ]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
        encoding: "utf8",
        env: { ...process.env, SASH_HOME: home },
        timeout: 30000,
      });
      assert.ifError(result.error);
      if (args.includes("--help")) {
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stdout, /^\s+tun\s/m);
      } else assert.notEqual(result.status, 0, result.stdout);
      assert.equal(fs.existsSync(home), false, args.join(" "));
    }
  });
});
