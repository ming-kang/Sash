import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { cleanUpgradeInstallation } from "./upgrade-activation.js";
import {
  assertPackageIdentity,
  parsePackageIdentity,
  readPackageIdentity,
  readShimImage,
  removePackageSlot,
  replaceShim,
} from "./upgrade-files.js";
import { cleanCompletedUpgradeArtifacts, completedUpgradeArtifacts } from "./upgrade-garbage.js";
import { readUpgradeJournal } from "./upgrade-journal.js";
import { upgradeTransactionPaths } from "./upgrade-paths.js";
import { upgradeFixture } from "./upgrade-test-fixture.test.js";

describe("upgrade file ownership", () => {
  it("tracks a renamed package directory without reading files and rejects a replacement", (t) => {
    const f = upgradeFixture();
    const previous = upgradeTransactionPaths(f.prefix, f.journal.transactionId).previous;
    try {
      const identity = readPackageIdentity(f.installation.packageRoot);
      assert.deepEqual(parsePackageIdentity(identity), identity);
      assert.throws(() => parsePackageIdentity({ ...identity, inode: "0" }), /identity/);
      t.mock.method(fs, "readFileSync", () => {
        throw new Error("Directory inspection must not read package contents");
      });
      fs.renameSync(f.installation.packageRoot, previous);
      assertPackageIdentity(previous, identity);
      fs.mkdirSync(f.installation.packageRoot);
      assert.throws(
        () => assertPackageIdentity(f.installation.packageRoot, identity),
        /replaced outside/,
      );
    } finally {
      f.cleanup();
    }
  });

  it("resumes directory cleanup without following links or scanning file contents", async () => {
    const f = upgradeFixture();
    const paths = upgradeTransactionPaths(f.prefix, f.journal.transactionId);
    try {
      await fs.promises.cp(f.installation.packageRoot, paths.previous, { recursive: true });
      const expected = readPackageIdentity(paths.previous);
      const outside = path.join(f.root, "external");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "keep.txt"), "preserve outside the transaction");
      fs.symlinkSync(
        outside,
        path.join(paths.previous, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
      fs.unlinkSync(path.join(paths.previous, "package.json"));
      await removePackageSlot(paths.previous, expected, paths.root);
      assert.equal(fs.existsSync(paths.previous), false);
      assert.equal(
        fs.readFileSync(path.join(outside, "keep.txt"), "utf8"),
        "preserve outside the transaction",
      );
      await assert.rejects(
        removePackageSlot(outside, readPackageIdentity(outside), paths.root),
        /escaped/,
      );
    } finally {
      f.cleanup();
    }
  });

  it("preserves a command shim changed by another owner", () => {
    const f = upgradeFixture();
    try {
      const shim = path.join(
        f.installation.binDir,
        process.platform === "win32" ? "sash.cmd" : "sash",
      );
      const before = readShimImage(shim);
      fs.unlinkSync(shim);
      fs.writeFileSync(shim, "different owner");
      assert.throws(
        () => replaceShim(shim, before, { kind: "absent" }, f.prefix),
        /ownership changed/,
      );
      assert.equal(fs.readFileSync(shim, "utf8"), "different owner");
    } finally {
      f.cleanup();
    }
  });

  it("finishes interrupted cleanup using its ownership marker without hashing the worker", async () => {
    const f = upgradeFixture();
    const paths = upgradeTransactionPaths(f.prefix, f.journal.transactionId);
    try {
      await assert.rejects(
        cleanUpgradeInstallation({ ...f.journal, phase: "cancel-cleanup" }, (boundary) => {
          if (boundary === "upgrade-journal-cleared") throw new Error("interrupted");
        }),
        /interrupted/,
      );
      assert.equal(readUpgradeJournal(f.prefix), undefined);
      assert.equal(completedUpgradeArtifacts(f.installation).length, 1);
      const extra = path.join(paths.root, "keep.txt");
      fs.writeFileSync(extra, "unknown file");
      await assert.rejects(cleanCompletedUpgradeArtifacts(f.installation), /unrecognized/);
      assert.equal(fs.readFileSync(extra, "utf8"), "unknown file");
      fs.unlinkSync(extra);
      fs.writeFileSync(paths.worker, "a regular file owned by the completed transaction");
      assert.equal(await cleanCompletedUpgradeArtifacts(f.installation), 1);
      assert.equal(fs.existsSync(paths.root), false);
      assert.equal(await cleanCompletedUpgradeArtifacts(f.installation), 0);
    } finally {
      f.cleanup();
    }
  });
});
