import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { cleanUpgradeInstallation } from "./upgrade-activation.js";
import {
  fingerprintTree,
  parseTreeFingerprint,
  readShimImage,
  removePackageSlot,
  replaceShim,
} from "./upgrade-files.js";
import { cleanCompletedUpgradeArtifacts, completedUpgradeArtifacts } from "./upgrade-garbage.js";
import { readUpgradeJournal } from "./upgrade-journal.js";
import { upgradeTransactionPaths } from "./upgrade-paths.js";
import { upgradeFixture } from "./upgrade-test-fixture.test.js";

describe("upgrade file ownership", () => {
  it("recovers completed cleanup without removing changed or unrecognized files", async () => {
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
      fs.writeFileSync(extra, "foreign content");
      await assert.rejects(cleanCompletedUpgradeArtifacts(f.installation), /unrecognized/);
      assert.equal(fs.readFileSync(extra, "utf8"), "foreign content");
      fs.unlinkSync(extra);
      const worker = fs.readFileSync(paths.worker);
      fs.writeFileSync(paths.worker, "changed worker");
      await assert.rejects(cleanCompletedUpgradeArtifacts(f.installation), /ownership changed/);
      assert.equal(fs.readFileSync(paths.worker, "utf8"), "changed worker");
      fs.writeFileSync(paths.worker, worker);
      assert.equal(await cleanCompletedUpgradeArtifacts(f.installation), 1);
      assert.equal(fs.existsSync(paths.root), false);
      assert.equal(await cleanCompletedUpgradeArtifacts(f.installation), 0);
    } finally {
      f.cleanup();
    }
  });

  it("authenticates the remaining subset after interrupted cleanup and keeps foreign additions", async () => {
    const f = upgradeFixture();
    const paths = upgradeTransactionPaths(f.prefix, f.journal.transactionId);
    const slot = path.join(paths.root, "previous-package");
    try {
      await fs.promises.cp(f.installation.packageRoot, slot, { recursive: true });
      const expected = fingerprintTree(slot);
      fs.unlinkSync(path.join(slot, "package.json"));
      fs.writeFileSync(path.join(slot, "foreign.txt"), "keep this change");
      assert.throws(() => removePackageSlot(slot, expected, paths.root), /changed or unknown/);
      assert.equal(fs.readFileSync(path.join(slot, "foreign.txt"), "utf8"), "keep this change");
      fs.unlinkSync(path.join(slot, "foreign.txt"));
      removePackageSlot(slot, expected, paths.root);
      assert.equal(fs.existsSync(slot), false);
    } finally {
      f.cleanup();
    }
  });

  it("does not follow package links out of their slot or replace a changed shim", () => {
    const f = upgradeFixture();
    try {
      const outside = path.join(f.root, "external");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "value"), "private");
      const link = path.join(f.installation.packageRoot, "external-link");
      fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => fingerprintTree(f.installation.packageRoot), /escapes/);
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
      assert.equal(fs.readFileSync(path.join(outside, "value"), "utf8"), "private");
    } finally {
      f.cleanup();
    }
  });

  it("rejects manifest traversal and a digest that no longer authenticates its entries", () => {
    const f = upgradeFixture();
    try {
      const fingerprint = fingerprintTree(f.installation.packageRoot);
      const invalid = structuredClone(fingerprint);
      assert.ok(invalid.manifest[0]);
      invalid.manifest[0][0] = "../other-package";
      assert.throws(() => parseTreeFingerprint(invalid), /manifest path/);
      assert.throws(
        () => parseTreeFingerprint({ ...fingerprint, sha256: "0".repeat(64) }),
        /does not match/,
      );
    } finally {
      f.cleanup();
    }
  });
});
