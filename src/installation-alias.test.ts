import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { npmPackageRoot } from "./installation.js";
import {
  installationRegistryPaths,
  listInstallationInstances,
  registerInstallationInstance,
} from "./installation-registry.js";
import { readUpgradeJournal } from "./upgrade-journal.js";
import { upgradePaths, upgradeTransactionPaths } from "./upgrade-paths.js";
import {
  fakeUpgradeRuntimes,
  upgradeFixture,
  writeFixturePackage,
} from "./upgrade-test-fixture.test.js";
import { SashUpgradeTransaction } from "./upgrade-transaction.js";

it("recognizes package aliases through an absent slot and rejects a foreign link target", () => {
  const f = upgradeFixture();
  try {
    const alias = path.join(f.root, "prefix-alias");
    fs.symlinkSync(f.prefix, alias, process.platform === "win32" ? "junction" : "dir");
    const dataDir = path.join(f.root, "instance");
    fs.mkdirSync(dataDir);
    const registered = registerInstallationInstance({
      schemaVersion: 1,
      installationId: f.installation.id,
      packageRoot: npmPackageRoot(alias),
      dataDir,
      nodePath: process.execPath,
      sashVersion: "1.0.0",
      pid: process.pid,
      bootId: "a".repeat(48),
      port: 27891,
      startedAt: "2026-09-10T00:00:00.000Z",
    });
    assert.deepEqual(listInstallationInstances(f.installation.id, npmPackageRoot(alias)), [
      registered,
    ]);
    const paths = upgradeTransactionPaths(f.installation.prefix, f.journal.transactionId);
    fs.renameSync(f.installation.packageRoot, paths.previous);
    assert.deepEqual(listInstallationInstances(f.installation.id, npmPackageRoot(alias)), [
      registered,
    ]);
    const registry = installationRegistryPaths(f.installation.id).instancesDir;
    const files = fs.readdirSync(registry);
    const before = files.map((file) => fs.readFileSync(path.join(registry, file), "utf8"));
    const foreign = path.join(f.root, "foreign-package");
    fs.mkdirSync(foreign);
    fs.symlinkSync(
      foreign,
      f.installation.packageRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(
      () => listInstallationInstances(f.installation.id, npmPackageRoot(alias)),
      /mismatched owner/,
    );
    assert.deepEqual(
      files.map((file) => fs.readFileSync(path.join(registry, file), "utf8")),
      before,
    );
  } finally {
    f.cleanup();
  }
});

it("reads recovery journals through prefix aliases without relaxing fixed installation roles", () => {
  const f = upgradeFixture();
  try {
    const alias = path.join(f.root, "prefix-alias");
    fs.symlinkSync(f.prefix, alias, process.platform === "win32" ? "junction" : "dir");
    assert.deepEqual(readUpgradeJournal(alias), f.journal);
    const paths = upgradeTransactionPaths(f.installation.prefix, f.journal.transactionId);
    fs.renameSync(f.installation.packageRoot, paths.previous);
    assert.deepEqual(readUpgradeJournal(alias), f.journal);
    const changed = structuredClone(f.journal);
    changed.installation.binDir = path.join(f.root, "foreign-bin");
    const journal = upgradePaths(f.installation.prefix).journal;
    atomicWriteFileSync(journal, JSON.stringify(changed));
    assert.throws(() => readUpgradeJournal(alias), /fixed installation roles/);
    assert.equal(fs.readFileSync(journal, "utf8"), JSON.stringify(changed));
  } finally {
    f.cleanup();
  }
});

for (const foreign of [false, true]) {
  it(`accepts only a preparation alias resolving to the owned staging slot (foreign=${foreign})`, async () => {
    const f = upgradeFixture();
    const runtime = fakeUpgradeRuntimes(f.root, f.installation, 0);
    try {
      const result = await new SashUpgradeTransaction(f.journal, {
        runtime: runtime.runtime,
        discoverInstances: async () => [],
        verifyPackage: async () => {},
        stagePackage: async ({ prefix, transactionId }) => {
          const stage = foreign
            ? path.join(f.root, "foreign-stage")
            : upgradeTransactionPaths(prefix, transactionId).stage;
          writeFixturePackage(stage, "2.0.0");
          const alias = path.join(f.root, "stage-alias");
          fs.symlinkSync(stage, alias, process.platform === "win32" ? "junction" : "dir");
          return npmPackageRoot(alias);
        },
      }).run(f.target);
      assert.equal(result.outcome, foreign ? "failed" : "upgraded", result.error);
      assert.equal(result.recoveryRequired, false, result.error);
      if (foreign) assert.match(result.error ?? "", /fixed staging slot/);
    } finally {
      f.cleanup();
    }
  });
}
