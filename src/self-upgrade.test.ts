import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { MockAgent } from "undici";
import { proxyAwareDispatcher } from "./http.js";
import { inspectInstallation, npmShimPaths } from "./installation.js";
import { inspectSashUpgrade } from "./self-upgrade.js";
import { upgradeChildEnv } from "./upgrade-command.js";
import { fingerprintTree, readShimImage, replaceShim } from "./upgrade-files.js";
import { activateUpgradeShims } from "./upgrade-launcher.js";
import { upgradePaths } from "./upgrade-paths.js";
import { upgradeFixture, writeFixturePackage } from "./upgrade-test-fixture.test.js";

describe("read-only Sash upgrade checks", () => {
  for (const scenario of [
    { version: "2.0.0", available: true, compatible: true },
    { version: "1.0.0", available: false, compatible: true },
    { version: "0.9.0", available: false, compatible: true },
    { version: "0.9.0", explicit: "0.9.0", available: true, compatible: true },
    { version: "2.0.0", node: ">=100", available: true, compatible: false },
    { version: "2.0.0", protocol: 2, available: true, compatible: false },
  ]) {
    it(`reports availability and compatibility without writing files: ${JSON.stringify(scenario)}`, async (t) => {
      const parent = fs.realpathSync(os.tmpdir());
      const root = fs.mkdtempSync(path.join(parent, "sash-upgrade-check-"));
      const prefix = path.join(root, "npm prefix 中文");
      const packageRoot = writeFixturePackage(prefix, "1.0.0");
      const agent = new MockAgent();
      agent.disableNetConnect();
      t.mock.method(proxyAwareDispatcher(), "dispatch", agent.dispatch.bind(agent));
      agent
        .get("https://registry.npmjs.org")
        .intercept({
          path: `/${encodeURIComponent("@astralyn/sash")}/${scenario.explicit ?? "latest"}`,
        })
        .reply(200, {
          name: "@astralyn/sash",
          version: scenario.version,
          engines: { node: scenario.node ?? ">=24" },
          bin: { sash: "dist/cli.js" },
          sashUpgradeProtocol: scenario.protocol ?? 1,
          dist: {
            tarball: `https://registry.npmjs.org/@astralyn/sash/-/sash-${scenario.version}.tgz`,
            integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
          },
        });
      const before = fingerprintTree(prefix);
      try {
        const { report } = await inspectSashUpgrade(scenario.explicit, {
          packageRoot,
          nodeVersion: "v24.0.0",
        });
        assert.equal(report.current, "1.0.0");
        assert.equal(report.target, scenario.version);
        assert.equal(report.available, scenario.available);
        assert.equal(report.compatible, scenario.compatible);
        assert.equal(report.supported, true);
        if (!scenario.compatible) assert.ok(report.reason);
        assert.equal(fs.existsSync(upgradePaths(prefix).root), false);
        assert.deepEqual(fingerprintTree(prefix), before);
        agent.assertNoPendingInterceptors();
      } finally {
        await agent.close();
        assert.equal(path.dirname(fs.realpathSync(root)), parent);
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    });
  }

  it("reports interrupted work before accessing the registry and leaves its journal unchanged", async (t) => {
    const f = upgradeFixture();
    const agent = new MockAgent();
    agent.disableNetConnect();
    t.mock.method(proxyAwareDispatcher(), "dispatch", agent.dispatch.bind(agent));
    try {
      const before = fingerprintTree(f.prefix);
      const { report } = await inspectSashUpgrade(undefined, {
        packageRoot: f.installation.packageRoot,
      });
      assert.deepEqual(report.pending, { from: "1.0.0", target: "2.0.0", phase: "preparing" });
      assert.deepEqual(fingerprintTree(f.prefix), before);
    } finally {
      await agent.close();
      f.cleanup();
    }
  });

  it("recognizes recovery through a native shim while other Windows shims still point to the launcher", {
    skip: process.platform !== "win32",
  }, async () => {
    const f = upgradeFixture();
    try {
      activateUpgradeShims(f.journal, "recovery");
      const file = npmShimPaths(f.prefix)[0];
      const source = f.journal.sourceShims[0];
      assert.ok(file && source);
      replaceShim(file, readShimImage(file), source, f.prefix);
      assert.equal(
        inspectInstallation({ packageRoot: f.installation.packageRoot }).kind,
        "unknown",
      );
      const before = fingerprintTree(f.prefix);
      const { report, installation } = await inspectSashUpgrade(undefined, {
        packageRoot: f.installation.packageRoot,
      });
      assert.equal(installation.kind, "npm-global");
      assert.equal(report.pending?.phase, "preparing");
      assert.deepEqual(fingerprintTree(f.prefix), before);
    } finally {
      f.cleanup();
    }
  });

  it("returns registry failures before creating recovery or application state", async (t) => {
    const f = upgradeFixture();
    fs.unlinkSync(upgradePaths(f.prefix).journal);
    const before = fingerprintTree(f.prefix);
    const agent = new MockAgent();
    agent.disableNetConnect();
    t.mock.method(proxyAwareDispatcher(), "dispatch", agent.dispatch.bind(agent));
    agent
      .get("https://registry.npmjs.org")
      .intercept({
        path: `/${encodeURIComponent("@astralyn/sash")}/latest`,
      })
      .reply(404, "not available");
    try {
      await assert.rejects(
        inspectSashUpgrade(undefined, { packageRoot: f.installation.packageRoot }),
        /HTTP 404/,
      );
      assert.deepEqual(fingerprintTree(f.prefix), before);
      agent.assertNoPendingInterceptors();
    } finally {
      await agent.close();
      f.cleanup();
    }
  });

  it("keeps source-checkout checks read-only and CLI JSON failures machine-readable", async () => {
    const parent = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(parent, "sash-upgrade-cli-"));
    const data = path.join(root, "unused-data");
    const repository = path.resolve(import.meta.dirname, "..");
    try {
      for (const [args, code] of [
        [["upgrade", "--check", "--json"], 0],
        [["upgrade", "--json"], 1],
        [["upgrade", "https://example.test/sash.tgz", "--json"], 1],
      ] as const) {
        const child = spawnSync(
          process.execPath,
          ["--import", "tsx", path.join(repository, "src", "cli.ts"), ...args],
          {
            cwd: repository,
            env: { ...upgradeChildEnv(), SASH_HOME: data },
            encoding: "utf8",
            windowsHide: true,
            timeout: 15_000,
          },
        );
        assert.equal(child.status, code, child.error?.message ?? child.stderr);
        assert.equal(child.stderr, "");
        const report = JSON.parse(child.stdout) as {
          supported?: boolean;
          installation?: string;
          outcome?: string;
          error?: string;
        };
        if (args[1] === "https://example.test/sash.tgz") {
          assert.equal(report.outcome, "failed");
          assert.match(report.error ?? "", /exact Sash version/);
        } else {
          assert.equal(report.supported, false);
          assert.equal(report.installation, inspectInstallation().kind);
        }
        assert.equal(fs.existsSync(data), false);
      }
    } finally {
      assert.equal(path.dirname(fs.realpathSync(root)), parent);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
