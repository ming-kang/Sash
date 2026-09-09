import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { npmPackageRoot, npmShimPaths } from "./installation.js";
import { activateUpgradePackage } from "./upgrade-activation.js";
import { fingerprintTree, readShimImage } from "./upgrade-files.js";
import {
  publishUpgradeBarrier,
  readUpgradeJournal,
  writeUpgradeJournal,
} from "./upgrade-journal.js";
import { verifyStagedShims } from "./upgrade-launcher.js";
import { upgradePaths, upgradeTransactionPaths } from "./upgrade-paths.js";
import {
  fakeUpgradeRuntimes,
  upgradeFixture,
  writeFixturePackage,
} from "./upgrade-test-fixture.test.js";
import { SashUpgradeTransaction, type UpgradeExecutionOptions } from "./upgrade-transaction.js";

describe("recoverable Sash installation transaction", () => {
  for (const failure of ["none", "reservation", "health", "cancel"] as const) {
    it(`settles all shared instances with owned package and shim roles (${failure})`, async () => {
      const f = upgradeFixture();
      const r = fakeUpgradeRuntimes(f.root, f.installation);
      const signal = new AbortController();
      const original = fingerprintTree(f.installation.packageRoot);
      const shims = npmShimPaths(f.prefix).map(readShimImage);
      if (failure === "reservation") r.failReservation(1);
      if (failure === "health") r.failRestoration(1);
      const options: UpgradeExecutionOptions = {
        runtime: r.runtime,
        signal: signal.signal,
        discoverInstances: async () => r.references,
        verifyPackage: async () => {},
        stagePackage: async ({ prefix, transactionId }) => {
          r.events.push("prepared dependencies");
          return writeFixturePackage(upgradeTransactionPaths(prefix, transactionId).stage, "2.0.0");
        },
        onBoundary: (name) => {
          if (failure === "cancel" && name === "instance-stopped:0")
            signal.abort(new Error("cancel requested"));
        },
      };
      try {
        const result = await new SashUpgradeTransaction(f.journal, options).run(f.target);
        assert.equal(result.outcome, failure === "none" ? "upgraded" : "failed", result.error);
        assert.equal(result.recoveryRequired, false, result.error);
        assert.equal(result.version, failure === "none" ? "2.0.0" : "1.0.0");
        assert.equal(readUpgradeJournal(f.prefix), undefined);
        assert.equal(fs.existsSync(upgradePaths(f.prefix).barrier), false);
        assert.equal(r.states.size, 2);
        assert.ok(
          [...r.states.values()].every(
            (state) => state.phase === "none" && state.record.sashVersion === result.version,
          ),
        );
        assert.equal(r.events[0], "prepared dependencies");
        if (failure !== "reservation")
          assert.ok(r.events.indexOf("reserve:data-1") < r.events.indexOf("stop:data-0"));
        else
          assert.equal(
            r.events.some((event) => event.startsWith("stop:")),
            false,
          );
        if (failure !== "none") {
          assert.deepEqual(fingerprintTree(f.installation.packageRoot), original);
          assert.deepEqual(npmShimPaths(f.prefix).map(readShimImage), shims);
        }
      } finally {
        f.cleanup();
      }
    });
  }

  it("leaves the original package and running instances available when preparation fails", async () => {
    const f = upgradeFixture();
    const r = fakeUpgradeRuntimes(f.root, f.installation);
    try {
      const result = await new SashUpgradeTransaction(f.journal, {
        runtime: r.runtime,
        stagePackage: async () => {
          throw new Error("registry unavailable");
        },
      }).run(f.target);
      assert.equal(result.outcome, "failed");
      assert.equal(result.recoveryRequired, false, result.error);
      assert.deepEqual(r.events, []);
      assert.equal(r.states.size, 2);
      assert.equal(readUpgradeJournal(f.prefix), undefined);
    } finally {
      f.cleanup();
    }
  });

  for (const boundary of ["instance-committed:0", "preparation-cleaned"]) {
    it(`reports success when committed cleanup succeeds on retry after ${boundary}`, async () => {
      const f = upgradeFixture();
      const r = fakeUpgradeRuntimes(f.root, f.installation);
      let interrupted = false;
      try {
        const result = await new SashUpgradeTransaction(f.journal, {
          runtime: r.runtime,
          discoverInstances: async () => r.references,
          verifyPackage: async () => {},
          stagePackage: async ({ prefix, transactionId }) =>
            writeFixturePackage(upgradeTransactionPaths(prefix, transactionId).stage, "2.0.0"),
          onBoundary: (name) => {
            if (name === boundary && !interrupted) {
              interrupted = true;
              throw new Error("transient cleanup failure");
            }
          },
        }).run(f.target);
        assert.equal(interrupted, true);
        assert.equal(result.outcome, "upgraded", result.error);
        assert.equal(result.version, "2.0.0");
        assert.equal(result.recoveryRequired, false);
        assert.equal(readUpgradeJournal(f.prefix), undefined);
        assert.ok(
          [...r.states.values()].every(
            (state) => state.phase === "none" && state.record.sashVersion === "2.0.0",
          ),
        );
        assert.equal(r.events.filter((event) => event.startsWith("restore:")).length, 2);
      } finally {
        f.cleanup();
      }
    });
  }

  for (const boundary of [
    "launcher-published",
    "recovery-shims-published",
    "previous-package-moved",
    "candidate-package-activated",
  ]) {
    it(`recovers actual file placement after interruption at ${boundary}`, async () => {
      const f = upgradeFixture();
      const r = fakeUpgradeRuntimes(f.root, f.installation, 0);
      const paths = upgradeTransactionPaths(f.prefix, f.journal.transactionId);
      try {
        const candidate = writeFixturePackage(paths.stage, "2.0.0");
        const journal = {
          ...f.journal,
          phase: "activating" as const,
          candidate: fingerprintTree(candidate),
          candidateShims: verifyStagedShims(paths.stage, candidate),
        };
        writeUpgradeJournal(journal);
        publishUpgradeBarrier(journal);
        await assert.rejects(
          activateUpgradePackage(journal, (name) => {
            if (name === boundary) throw new Error("interrupted");
          }),
          /interrupted/,
        );
        if (boundary === "previous-package-moved")
          assert.equal(fs.existsSync(npmPackageRoot(f.prefix)), false);
        const persisted = readUpgradeJournal(f.prefix);
        assert.ok(persisted);
        const result = await new SashUpgradeTransaction(persisted, {
          runtime: r.runtime,
        }).recover();
        assert.equal(result.outcome, "recovered", result.error);
        assert.equal(result.version, "1.0.0");
        assert.deepEqual(fingerprintTree(f.installation.packageRoot), journal.source);
        assert.equal(readUpgradeJournal(f.prefix), undefined);
      } finally {
        f.cleanup();
      }
    });
  }

  it("preserves a foreign change to the active package instead of replacing it during rollback", async () => {
    const f = upgradeFixture();
    const r = fakeUpgradeRuntimes(f.root, f.installation, 0);
    const marker = path.join(f.installation.packageRoot, "foreign.txt");
    try {
      const result = await new SashUpgradeTransaction(f.journal, {
        runtime: r.runtime,
        discoverInstances: async () => [],
        verifyPackage: async () => {},
        stagePackage: async ({ prefix, transactionId }) =>
          writeFixturePackage(upgradeTransactionPaths(prefix, transactionId).stage, "2.0.0"),
        onBoundary: (name) => {
          if (name === "journal:activating") fs.writeFileSync(marker, "preserve me");
        },
      }).run(f.target);
      assert.equal(result.recoveryRequired, true);
      assert.equal(fs.readFileSync(marker, "utf8"), "preserve me");
      assert.ok(readUpgradeJournal(f.prefix));
    } finally {
      f.cleanup();
    }
  });
});
