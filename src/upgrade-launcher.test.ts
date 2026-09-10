import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { findExecutableOnPath } from "./process.js";
import { acquireStateLock } from "./state-lock.js";
import { activateUpgradePackage } from "./upgrade-activation.js";
import { runUpgradeCommand, upgradeChildEnv } from "./upgrade-command.js";
import { readPackageIdentity } from "./upgrade-files.js";
import { completedUpgradeArtifacts } from "./upgrade-garbage.js";
import {
  publishUpgradeBarrier,
  readUpgradeJournal,
  writeUpgradeJournal,
} from "./upgrade-journal.js";
import {
  publishRecoveryLauncher,
  RECOVERY_LAUNCHER,
  verifyStagedShims,
} from "./upgrade-launcher.js";
import { upgradePaths, upgradeTransactionPaths } from "./upgrade-paths.js";
import { upgradeFixture, writeFixturePackage } from "./upgrade-test-fixture.test.js";

describe("standalone Sash recovery entry", () => {
  const temporaryParent = fs.realpathSync(os.tmpdir());
  let builtRoot: string;
  let worker: Buffer;
  before(async () => {
    builtRoot = fs.mkdtempSync(path.join(temporaryParent, "sash-worker-test-"));
    const repository = path.resolve(import.meta.dirname, "..");
    await runUpgradeCommand(
      process.execPath,
      [path.join(repository, "scripts", "build-upgrade-worker.mjs"), builtRoot],
      { cwd: repository, purpose: "Build isolated recovery worker", timeoutMs: 30_000 },
    );
    worker = fs.readFileSync(path.join(builtRoot, "upgrade-worker.mjs"));
    assert.match(worker.toString(), /Copyright.*Undici contributors/);
  });
  after(() => {
    assert.equal(path.dirname(fs.realpathSync(builtRoot)), temporaryParent);
    fs.rmSync(builtRoot, { recursive: true, force: true });
  });

  it("retries launcher publication after an interruption before metadata was written", () => {
    const f = upgradeFixture(worker);
    const paths = upgradePaths(f.prefix);
    try {
      fs.writeFileSync(paths.launcher, RECOVERY_LAUNCHER);
      publishRecoveryLauncher(f.journal);
      assert.equal(
        JSON.parse(fs.readFileSync(paths.launcherInfo, "utf8")).installationId,
        f.installation.id,
      );
      fs.writeFileSync(paths.launcher, "foreign launcher");
      fs.unlinkSync(paths.launcherInfo);
      assert.throws(() => publishRecoveryLauncher(f.journal), /no ownership record/);
      assert.equal(fs.readFileSync(paths.launcher, "utf8"), "foreign launcher");
    } finally {
      f.cleanup();
    }
  });

  it("rejects a second updater without changing the pending transaction", async () => {
    const f = upgradeFixture(worker);
    const paths = upgradeTransactionPaths(f.prefix, f.journal.transactionId);
    const lease = await acquireStateLock(upgradePaths(f.prefix).lock, {
      purpose: "first upgrade",
      timeoutMs: 0,
    });
    try {
      await assert.rejects(
        runUpgradeCommand(process.execPath, [paths.worker, "--recover", f.prefix], {
          cwd: f.root,
          purpose: "Attempt concurrent upgrade",
          timeoutMs: 10_000,
        }),
        /lock|first upgrade/i,
      );
      assert.deepEqual(readUpgradeJournal(f.prefix), f.journal);
      assert.deepEqual(readPackageIdentity(f.installation.packageRoot), f.journal.source);
    } finally {
      lease.release();
      f.cleanup();
    }
  });

  for (const extension of [
    "bootstrap",
    ...(process.platform === "win32" ? [".ps1", ".cmd"] : [""]),
  ]) {
    it(`runs recovery through the installed ${extension || "shell"} shim while the package is absent`, async () => {
      const f = upgradeFixture(worker);
      const paths = upgradeTransactionPaths(f.prefix, f.journal.transactionId);
      try {
        const candidate = writeFixturePackage(paths.stage, "2.0.0");
        const journal = {
          ...f.journal,
          phase: "activating" as const,
          candidate: readPackageIdentity(candidate),
          candidateShims: verifyStagedShims(paths.stage, candidate),
        };
        writeUpgradeJournal(journal);
        publishUpgradeBarrier(journal);
        await assert.rejects(
          activateUpgradePackage(journal, (boundary) => {
            if (boundary === "previous-package-moved") throw new Error("interruption");
          }),
          /interruption/,
        );
        assert.equal(fs.existsSync(f.installation.packageRoot), false);
        const shim = path.join(f.installation.binDir, `sash${extension}`);
        const bootstrap = path.join(f.root, "bootstrap.mjs");
        if (extension === "bootstrap")
          fs.writeFileSync(
            bootstrap,
            [
              `import { executeSashUpgrade } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "self-upgrade.ts")).href)};`,
              `process.exitCode = await executeSashUpgrade(${JSON.stringify(f.installation)}, { recover: true, json: true });`,
            ].join("\n"),
          );
        const output =
          extension === "bootstrap"
            ? await runUpgradeCommand(
                process.execPath,
                [
                  "--import",
                  pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
                  bootstrap,
                ],
                {
                  cwd: f.root,
                  purpose: "Recover from the recorded independent worker",
                  timeoutMs: 30_000,
                },
              )
            : process.platform === "win32"
              ? await runUpgradeCommand(
                  findExecutableOnPath("pwsh.exe") ?? "pwsh",
                  [
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "& $env:SASH_TEST_RECOVERY_SHIM upgrade --json; exit $LASTEXITCODE",
                  ],
                  {
                    cwd: f.root,
                    purpose: "Recover through the Windows npm shim",
                    timeoutMs: 30_000,
                    env: { ...process.env, SASH_TEST_RECOVERY_SHIM: shim },
                  },
                )
              : await runUpgradeCommand("/bin/sh", [shim, "upgrade", "--json"], {
                  cwd: f.root,
                  purpose: "Recover through the npm bin shim",
                  timeoutMs: 30_000,
                });
        const result = JSON.parse(output) as { outcome: string; version: string };
        assert.equal(result.outcome, "recovered");
        assert.equal(result.version, "1.0.0");
        assert.equal(readUpgradeJournal(f.prefix), undefined);
        assert.deepEqual(readPackageIdentity(f.installation.packageRoot), journal.source);
      } finally {
        f.cleanup();
      }
    });
  }

  const interruptions = [
    ...[
      "journal:preparing",
      "journal:prepared",
      "journal:reserving",
      "startup-barrier-published",
      "login-startup-captured",
      "journal:stopping",
      "journal:activating",
      "launcher-published",
      "recovery-shims-published",
      "previous-package-moved",
      "candidate-package-activated",
      "candidate-shims-activated",
      "login-startup-restored",
      "journal:restoring",
      "journal:committed",
      "journal:commit-cleanup",
      "package-backups-cleaned",
      "preparation-cleaned",
      "startup-admission-released",
      "upgrade-journal-cleared",
    ].map((boundary) => ({ boundary, failAfter: "" })),
    ...["journal:cancelled", "journal:cancel-cleanup"].map((boundary) => ({
      boundary,
      failAfter: "journal:prepared",
    })),
    ...[
      "journal:rolling-back",
      "rollback-recovery-shims",
      "rejected-package-moved",
      "previous-package-restored",
      "journal:rolled-back",
      "journal:rollback-cleanup",
    ].map((boundary) => ({ boundary, failAfter: "candidate-shims-activated" })),
  ];
  for (const { boundary, failAfter } of interruptions) {
    it(`recovers after the updater process exits at ${boundary}`, { timeout: 30_000 }, async () => {
      const f = upgradeFixture(worker);
      const paths = upgradeTransactionPaths(f.prefix, f.journal.transactionId);
      const script = path.join(f.root, "interrupt.mjs");
      const module = (file: string) =>
        JSON.stringify(pathToFileURL(path.join(import.meta.dirname, file)).href);
      fs.writeFileSync(
        script,
        [
          `import { readUpgradeJournal } from ${module("upgrade-journal.ts")};`,
          `import { SashUpgradeTransaction } from ${module("upgrade-transaction.ts")};`,
          `import { upgradeTransactionPaths } from ${module("upgrade-paths.ts")};`,
          `import { writeFixturePackage } from ${module("upgrade-test-fixture.test.ts")};`,
          `const [prefix, boundary] = process.argv.slice(2);`,
          `if (boundary === "journal:preparing") process.exit(77);`,
          `const journal = readUpgradeJournal(prefix);`,
          `const result = await new SashUpgradeTransaction(journal, {`,
          `  stagePackage: async ({ prefix, transactionId }) => writeFixturePackage(upgradeTransactionPaths(prefix, transactionId).stage, "2.0.0"),`,
          `  discoverInstances: async () => [], verifyPackage: async () => {},`,
          `  onBoundary: (name) => { if (name === boundary) process.exit(77); if (name === ${JSON.stringify(failAfter)}) throw new Error("Fixture upgrade failure"); }`,
          `}).run(${JSON.stringify(f.target)});`,
          `process.stderr.write(JSON.stringify(result)); process.exit(78);`,
        ].join("\n"),
      );
      try {
        const child = spawnSync(
          process.execPath,
          [
            "--import",
            pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
            script,
            f.prefix,
            boundary,
          ],
          {
            cwd: f.root,
            env: upgradeChildEnv(),
            encoding: "utf8",
            timeout: 20_000,
            windowsHide: true,
          },
        );
        assert.equal(child.status, 77, child.error?.message ?? child.stderr);
        const pending = readUpgradeJournal(f.prefix);
        if (boundary !== "upgrade-journal-cleared") assert.ok(pending);
        const committed =
          !pending || pending.phase === "committed" || pending.phase === "commit-cleanup";
        const expected = pending
          ? committed
            ? pending.candidate
            : pending.source
          : readPackageIdentity(f.installation.packageRoot);
        const output = await runUpgradeCommand(
          process.execPath,
          [paths.worker, "--recover", f.prefix, "--json"],
          { cwd: f.root, purpose: "Recover a killed upgrade worker", timeoutMs: 20_000 },
        );
        const result = JSON.parse(output) as { outcome: string; version: string };
        assert.equal(result.outcome, "recovered");
        assert.equal(result.version, committed ? "2.0.0" : "1.0.0");
        assert.equal(readUpgradeJournal(f.prefix), undefined);
        assert.deepEqual(readPackageIdentity(f.installation.packageRoot), expected);
        assert.deepEqual(completedUpgradeArtifacts(f.installation), []);
      } finally {
        f.cleanup();
      }
    });
  }
});
