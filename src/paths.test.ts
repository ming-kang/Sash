import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { sashLayout, sashRoot } from "./paths.js";

describe("paths", () => {
  let originalSashHome: string | undefined;
  let tmpDirs: string[] = [];

  beforeEach(() => {
    originalSashHome = process.env.SASH_HOME;
    tmpDirs = [];
  });

  afterEach(() => {
    if (originalSashHome !== undefined) {
      process.env.SASH_HOME = originalSashHome;
    } else {
      delete process.env.SASH_HOME;
    }
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    }
  });

  function createTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-paths-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  describe("sashRoot", () => {
    it("returns SASH_HOME when set to an absolute path", () => {
      const customDir = createTmpDir();
      process.env.SASH_HOME = customDir;
      assert.equal(sashRoot(), customDir);
    });

    it("throws an error when SASH_HOME is a relative path", () => {
      process.env.SASH_HOME = "relative/sash/path";
      assert.throws(
        () => sashRoot(),
        (err: Error) => {
          assert.match(err.message, /SASH_HOME must be an absolute path/);
          return true;
        },
      );
    });

    it("returns a platform-default absolute path when SASH_HOME is not set", () => {
      delete process.env.SASH_HOME;
      const root = sashRoot();
      assert.ok(path.isAbsolute(root), `Expected absolute path, got: ${root}`);
      if (process.platform === "win32") {
        assert.match(root, /Sash$/i);
      } else if (process.platform === "darwin") {
        assert.ok(root.includes(path.join("Library", "Application Support", "Sash")));
      } else {
        assert.match(root, /sash$/);
      }
    });
  });

  describe("sashLayout", () => {
    it("constructs correct layout paths for a specified root", () => {
      const customRoot = createTmpDir();
      const layout = sashLayout(customRoot);

      const expectedExeName = process.platform === "win32" ? "mihomo.exe" : "mihomo";
      assert.equal(layout.root, customRoot);
      assert.equal(layout.binDir, path.join(customRoot, "bin"));
      assert.equal(layout.coreExe, path.join(customRoot, "bin", expectedExeName));
      assert.equal(layout.configFile, path.join(customRoot, "config.yaml"));
      assert.equal(layout.settingsFile, path.join(customRoot, "sash.json"));
      assert.equal(layout.uiDir, path.join(customRoot, "ui"));
      assert.equal(layout.stateDir, path.join(customRoot, "state"));
      assert.equal(layout.pidFile, path.join(customRoot, "state", "sash.pid"));
      assert.equal(layout.daemonPidFile, path.join(customRoot, "state", "sashd.pid"));
      assert.equal(layout.daemonLeaseFile, path.join(customRoot, "state", "sashd.lock"));
      assert.equal(layout.daemonStartLockFile, path.join(customRoot, "state", "sashd-start.lock"));
      assert.equal(layout.runtimeOperationLockFile, path.join(customRoot, "state", "runtime.lock"));
      assert.equal(layout.mutationLockFile, path.join(customRoot, "state", "mutation.lock"));
      assert.equal(layout.settingsLockFile, path.join(customRoot, "state", "settings.lock"));
      assert.equal(
        layout.systemProxyStateFile,
        path.join(customRoot, "state", "system-proxy.json"),
      );
      assert.equal(
        layout.managedStateTransactionFile,
        path.join(customRoot, "state", "managed-state-transaction.json"),
      );
      assert.equal(layout.installFile, path.join(customRoot, "state", "install.json"));
      assert.equal(layout.logsDir, path.join(customRoot, "logs"));
      assert.equal(layout.coreLogFile, path.join(customRoot, "logs", "mihomo.log"));
      assert.equal(layout.coreErrLogFile, path.join(customRoot, "logs", "mihomo.err.log"));
      assert.equal(layout.sashLogFile, path.join(customRoot, "logs", "sash.log"));
      assert.equal(layout.daemonLogFile, path.join(customRoot, "logs", "sashd.log"));
      assert.equal(layout.daemonErrLogFile, path.join(customRoot, "logs", "sashd.err.log"));
      assert.equal(layout.tempDir, path.join(customRoot, "temp"));
    });

    it("defaults to sashRoot() when no root is provided", () => {
      const customDir = createTmpDir();
      process.env.SASH_HOME = customDir;
      const layout = sashLayout();
      assert.equal(layout.root, customDir);
    });
  });
});
