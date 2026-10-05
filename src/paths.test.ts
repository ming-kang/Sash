import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { sashRoot } from "./paths.js";

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
      } catch {}
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
});
