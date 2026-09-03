import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readInstallRecord, writeInstallRecord } from "./core.js";
import {
  beginCoreRepairUpdateTransaction,
  beginCoreUpdateTransaction,
  type CoreUpdateRuntime,
  commitCoreUpdate,
  completePendingCoreUpdateAfterStart,
  finalizeCoreUpdateTransaction,
  markCoreUpdateHealthVerified,
  markCoreUpdateSwapped,
  quarantineCoreInstallationForUpdate,
  readCoreUpdateTransaction,
  recoverCoreUpdateTransaction,
  rollbackCoreUpdateTransaction,
} from "./core-update.js";
import { type SashLayout, sashLayout } from "./paths.js";

describe("core update transaction", () => {
  let tmpDir: string;
  let layout: SashLayout;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sash-core-update-test-"));
    layout = sashLayout(tmpDir);
    fs.mkdirSync(layout.binDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function staged(version: string, content = `${version}-core`) {
    const exe = path.join(layout.binDir, `staged-${version}`);
    fs.writeFileSync(exe, content);
    return { version, exe };
  }

  function verify(exe: string, expectedVersion: string): void {
    if (fs.readFileSync(exe, "utf8") !== `${expectedVersion}-core`) {
      throw new Error("version mismatch");
    }
  }

  function seed(version = "v1"): void {
    fs.writeFileSync(layout.coreExe, `${version}-core`);
    writeInstallRecord({ coreVersion: version, installedAt: "2025-01-01T00:00:00.000Z" }, layout);
  }

  it("defers a stopped Core health check and retains the previous record and binary", async () => {
    seed();

    const result = await commitCoreUpdate({
      layout,
      staged: staged("v2"),
      verifyExecutable: verify,
    });

    assert.equal(result.pendingStartupValidation, true);
    assert.equal(result.backupRemoved, false);
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v2-core");
    assert.equal(fs.readFileSync(`${layout.coreExe}.bak`, "utf8"), "v1-core");
    assert.equal(readInstallRecord(layout)?.coreVersion, "v1");
    assert.deepEqual(readCoreUpdateTransaction(layout)?.phase, "swapped");

    recoverCoreUpdateTransaction(layout, verify);
    assert.equal(readInstallRecord(layout)?.coreVersion, "v1");
    assert.equal(completePendingCoreUpdateAfterStart(layout, verify), "v2");
    assert.equal(readInstallRecord(layout)?.coreVersion, "v2");
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), false);
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("keeps a first update startable while runtime validation is pending", async () => {
    const result = await commitCoreUpdate({
      layout,
      staged: staged("v1"),
      verifyExecutable: verify,
    });

    assert.equal(result.pendingStartupValidation, true);
    assert.equal(readInstallRecord(layout)?.coreVersion, "v1");
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), false);
    assert.equal(completePendingCoreUpdateAfterStart(layout, verify), "v1");
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("journals forced repair artifacts until a deferred candidate starts", async () => {
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(layout.coreExe, "ambiguous-core");
    fs.writeFileSync(layout.installFile, "{ malformed");

    const result = await commitCoreUpdate({
      layout,
      staged: staged("v2"),
      forceRepair: true,
      verifyExecutable: verify,
    });

    const transaction = readCoreUpdateTransaction(layout);
    assert.equal(transaction?.version, 2);
    assert.equal(transaction?.phase, "swapped");
    assert.deepEqual(transaction?.version === 2 ? transaction.repair : undefined, {
      binaryExisted: true,
      installRecordExisted: true,
    });
    assert.equal(result.pendingStartupValidation, true);
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v2-core");
    assert.equal(fs.readFileSync(`${layout.coreExe}.repair.bak`, "utf8"), "ambiguous-core");
    assert.equal(fs.readFileSync(`${layout.installFile}.repair.bak`, "utf8"), "{ malformed");
    assert.equal(readInstallRecord(layout)?.coreVersion, "v2");

    assert.equal(completePendingCoreUpdateAfterStart(layout, verify), "v2");
    assert.equal(fs.existsSync(`${layout.coreExe}.repair.bak`), false);
    assert.equal(fs.existsSync(`${layout.installFile}.repair.bak`), false);
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("preserves a forced candidate when its required quarantine backup is missing", async () => {
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(layout.coreExe, "ambiguous-core");
    fs.writeFileSync(layout.installFile, "{ malformed");
    await commitCoreUpdate({
      layout,
      staged: staged("v2"),
      forceRepair: true,
      verifyExecutable: verify,
    });
    fs.rmSync(`${layout.coreExe}.repair.bak`);

    assert.throws(
      () => rollbackCoreUpdateTransaction(layout, verify),
      /lost the quarantined executable/,
    );

    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v2-core");
    assert.equal(readCoreUpdateTransaction(layout)?.phase, "swapped");
    assert.equal(fs.readFileSync(`${layout.installFile}.repair.bak`, "utf8"), "{ malformed");
  });

  it("restores exact invalid artifacts when a forced candidate fails health", async () => {
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(layout.coreExe, "ambiguous-core");
    fs.writeFileSync(layout.installFile, "{ malformed");
    const runtime: CoreUpdateRuntime = {
      verifyRuntime: true,
      stop: async () => {},
      startAndVerify: async () => {
        throw new Error("candidate unhealthy");
      },
    };

    await assert.rejects(
      () =>
        commitCoreUpdate({
          layout,
          staged: staged("v2"),
          forceRepair: true,
          runtime,
          verifyExecutable: verify,
        }),
      /candidate unhealthy/,
    );

    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "ambiguous-core");
    assert.equal(fs.readFileSync(layout.installFile, "utf8"), "{ malformed");
    assert.equal(fs.existsSync(`${layout.coreExe}.repair.bak`), false);
    assert.equal(fs.existsSync(`${layout.installFile}.repair.bak`), false);
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("recovers a crash between forced repair quarantine moves", () => {
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(layout.coreExe, "ambiguous-core");
    fs.writeFileSync(layout.installFile, "{ malformed");
    beginCoreRepairUpdateTransaction(layout, "v2", true);
    fs.renameSync(layout.coreExe, `${layout.coreExe}.repair.bak`);

    recoverCoreUpdateTransaction(layout, verify);

    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "ambiguous-core");
    assert.equal(fs.readFileSync(layout.installFile, "utf8"), "{ malformed");
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("continues an interrupted forced-repair restoration", () => {
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(layout.coreExe, "ambiguous-core");
    fs.writeFileSync(layout.installFile, "{ malformed");
    let transaction = beginCoreRepairUpdateTransaction(layout, "v2", true);
    transaction = quarantineCoreInstallationForUpdate(transaction, layout);
    fs.writeFileSync(layout.coreExe, "v2-core");
    transaction = markCoreUpdateSwapped(transaction, layout);
    writeInstallRecord(transaction.targetRecord, layout);
    fs.rmSync(layout.coreExe);
    fs.renameSync(`${layout.coreExe}.repair.bak`, layout.coreExe);
    fs.writeFileSync(
      layout.coreUpdateTransactionFile,
      `${JSON.stringify({ ...transaction, phase: "repair-restoring" }, null, 2)}\n`,
    );

    recoverCoreUpdateTransaction(layout, verify);

    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "ambiguous-core");
    assert.equal(fs.readFileSync(layout.installFile, "utf8"), "{ malformed");
    assert.equal(fs.existsSync(`${layout.installFile}.repair.bak`), false);
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("rejects directory repair targets before creating a journal", () => {
    fs.mkdirSync(layout.coreExe, { recursive: true });
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(layout.installFile, "{ malformed");

    assert.throws(
      () => beginCoreRepairUpdateTransaction(layout, "v2", true),
      /executable path is a directory/,
    );
    assert.equal(fs.existsSync(layout.coreUpdateTransactionFile), false);
    assert.equal(fs.lstatSync(layout.coreExe).isDirectory(), true);
  });

  it("fails closed on a repair quarantine without its journal", () => {
    fs.writeFileSync(`${layout.coreExe}.repair.bak`, "ambiguous-core");

    assert.throws(
      () => recoverCoreUpdateTransaction(layout, verify),
      /repair backup without its transaction journal/,
    );
    assert.equal(fs.readFileSync(`${layout.coreExe}.repair.bak`, "utf8"), "ambiguous-core");
  });

  it("retains a runtime-verified rollback slot until external restoration", async () => {
    seed();
    let starts = 0;
    let stops = 0;
    const runtime: CoreUpdateRuntime = {
      verifyRuntime: true,
      stop: async () => {
        stops += 1;
      },
      startAndVerify: async (expectedVersion) => {
        starts += 1;
        assert.equal(expectedVersion, "v2");
      },
    };

    const result = await commitCoreUpdate({
      layout,
      staged: staged("v2"),
      runtime,
      verifyExecutable: verify,
    });

    assert.equal(result.pendingStartupValidation, false);
    assert.equal(result.backupRemoved, false);
    assert.equal(starts, 1);
    assert.equal(stops, 1);
    assert.equal(readCoreUpdateTransaction(layout)?.phase, "health-verified");
    assert.equal(readInstallRecord(layout)?.coreVersion, "v2");
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), true);

    finalizeCoreUpdateTransaction(layout, verify);
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), false);
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("restores binary, metadata, and the old runtime when health verification fails", async () => {
    seed();
    let starts = 0;
    let stops = 0;
    const runtime: CoreUpdateRuntime = {
      verifyRuntime: true,
      stop: async () => {
        stops += 1;
      },
      startAndVerify: async (expectedVersion) => {
        starts += 1;
        if (expectedVersion === "v2") throw new Error("new core unhealthy");
        assert.equal(expectedVersion, "v1");
      },
    };

    await assert.rejects(
      () =>
        commitCoreUpdate({
          layout,
          staged: staged("v2"),
          runtime,
          verifyExecutable: verify,
        }),
      /new core unhealthy/,
    );

    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
    assert.equal(readInstallRecord(layout)?.coreVersion, "v1");
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), false);
    assert.equal(readCoreUpdateTransaction(layout), undefined);
    assert.equal(starts, 2);
    assert.equal(stops, 2);
  });

  it("restores coordinated managed state before the previous binary and runtime", async () => {
    seed();
    fs.writeFileSync(layout.configFile, "candidate config");
    const events: string[] = [];
    const runtime: CoreUpdateRuntime = {
      verifyRuntime: true,
      stop: async () => {
        events.push("runtime:stop");
      },
      startAndVerify: async (expectedVersion) => {
        events.push(`runtime:start:${expectedVersion}`);
        if (expectedVersion === "v2") throw new Error("candidate unhealthy");
        assert.equal(fs.readFileSync(layout.configFile, "utf8"), "previous config");
        assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
      },
    };

    await assert.rejects(
      () =>
        commitCoreUpdate({
          layout,
          staged: staged("v2"),
          runtime,
          verifyExecutable: verify,
          beforeRollback: () => {
            events.push("managed:rollback");
            assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v2-core");
            fs.writeFileSync(layout.configFile, "previous config");
          },
        }),
      /candidate unhealthy/,
    );

    assert.deepEqual(events, [
      "runtime:stop",
      "runtime:start:v2",
      "runtime:stop",
      "managed:rollback",
      "runtime:start:v1",
    ]);
  });

  it("continues binary rollback when coordinated managed rollback fails", async () => {
    seed();
    const runtime: CoreUpdateRuntime = {
      verifyRuntime: true,
      stop: async () => {},
      startAndVerify: async (expectedVersion) => {
        if (expectedVersion === "v2") throw new Error("candidate unhealthy");
      },
    };

    await assert.rejects(
      () =>
        commitCoreUpdate({
          layout,
          staged: staged("v2"),
          runtime,
          verifyExecutable: verify,
          beforeRollback: () => {
            throw new Error("managed rollback failed");
          },
        }),
      /candidate unhealthy; rollback also failed: managed state: managed rollback failed/,
    );

    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
    assert.equal(readInstallRecord(layout)?.coreVersion, "v1");
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("recovers prepared crashes before and during the binary swap", () => {
    seed();
    const previous = readInstallRecord(layout);
    assert.ok(previous);

    beginCoreUpdateTransaction(layout, "v2", previous, false);
    recoverCoreUpdateTransaction(layout, verify);
    assert.equal(readCoreUpdateTransaction(layout), undefined);
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");

    const transaction = beginCoreUpdateTransaction(layout, "v2", previous, false);
    fs.renameSync(layout.coreExe, `${layout.coreExe}.bak`);
    recoverCoreUpdateTransaction(layout, verify);
    assert.equal(readCoreUpdateTransaction(layout), undefined);
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
    assert.equal(transaction.phase, "prepared");

    beginCoreUpdateTransaction(layout, "v2", previous, false);
    fs.renameSync(layout.coreExe, `${layout.coreExe}.bak`);
    fs.writeFileSync(layout.coreExe, "v2-core");
    recoverCoreUpdateTransaction(layout, verify);
    assert.equal(readCoreUpdateTransaction(layout), undefined);
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
  });

  it("rolls back an interrupted in-command swapped phase", () => {
    seed();
    const previous = readInstallRecord(layout);
    assert.ok(previous);
    let transaction = beginCoreUpdateTransaction(layout, "v2", previous, false);
    fs.renameSync(layout.coreExe, `${layout.coreExe}.bak`);
    fs.writeFileSync(layout.coreExe, "v2-core");
    transaction = markCoreUpdateSwapped(transaction, layout);

    recoverCoreUpdateTransaction(layout, verify);

    assert.equal(transaction.phase, "swapped");
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
    assert.equal(readInstallRecord(layout)?.coreVersion, "v1");
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("finishes metadata publication after a health-verified crash", () => {
    seed();
    const previous = readInstallRecord(layout);
    assert.ok(previous);
    let transaction = beginCoreUpdateTransaction(layout, "v2", previous, false);
    fs.renameSync(layout.coreExe, `${layout.coreExe}.bak`);
    fs.writeFileSync(layout.coreExe, "v2-core");
    transaction = markCoreUpdateSwapped(transaction, layout);
    markCoreUpdateHealthVerified(transaction, layout);

    recoverCoreUpdateTransaction(layout, verify);

    assert.equal(readInstallRecord(layout)?.coreVersion, "v2");
    assert.equal(readCoreUpdateTransaction(layout)?.phase, "health-verified");
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), true);
    finalizeCoreUpdateTransaction(layout, verify);
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("finishes a health-verified cleanup interrupted after backup removal", () => {
    seed();
    const previous = readInstallRecord(layout);
    assert.ok(previous);
    let transaction = beginCoreUpdateTransaction(layout, "v2", previous, false);
    fs.renameSync(layout.coreExe, `${layout.coreExe}.bak`);
    fs.writeFileSync(layout.coreExe, "v2-core");
    transaction = markCoreUpdateSwapped(transaction, layout);
    markCoreUpdateHealthVerified(transaction, layout);
    writeInstallRecord({ coreVersion: "v2", installedAt: transaction.createdAt }, layout);
    fs.rmSync(`${layout.coreExe}.bak`);

    finalizeCoreUpdateTransaction(layout, verify);

    assert.equal(readInstallRecord(layout)?.coreVersion, "v2");
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("preserves the journal and both binaries when rollback ownership is unresolved", async () => {
    seed();
    let stops = 0;
    const runtime: CoreUpdateRuntime = {
      verifyRuntime: true,
      stop: async () => {
        stops += 1;
        if (stops > 1) throw new Error("candidate still running");
      },
      startAndVerify: async () => {
        throw new Error("candidate unhealthy");
      },
    };

    await assert.rejects(
      () =>
        commitCoreUpdate({
          layout,
          staged: staged("v2"),
          runtime,
          verifyExecutable: verify,
        }),
      /candidate unhealthy; rollback also failed: candidate still running/,
    );

    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v2-core");
    assert.equal(fs.readFileSync(`${layout.coreExe}.bak`, "utf8"), "v1-core");
    assert.equal(readInstallRecord(layout)?.coreVersion, "v1");
    assert.equal(readCoreUpdateTransaction(layout)?.phase, "swapped");
  });

  it("fails closed when a deferred rollback backup is missing", async () => {
    seed();
    await commitCoreUpdate({
      layout,
      staged: staged("v2"),
      verifyExecutable: verify,
    });
    fs.rmSync(`${layout.coreExe}.bak`);

    assert.throws(
      () => recoverCoreUpdateTransaction(layout, verify),
      /missing its rollback backup/,
    );
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v2-core");
    assert.equal(readCoreUpdateTransaction(layout)?.phase, "swapped");
  });

  it("rolls a pending candidate back explicitly after a failed managed start", async () => {
    seed();
    await commitCoreUpdate({
      layout,
      staged: staged("v2"),
      verifyExecutable: verify,
    });

    const previous = rollbackCoreUpdateTransaction(layout, verify);

    assert.equal(previous?.coreVersion, "v1");
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
    assert.equal(readInstallRecord(layout)?.coreVersion, "v1");
    assert.equal(readCoreUpdateTransaction(layout), undefined);
  });

  it("rejects malformed, oversized, and non-regular journal files", () => {
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.writeFileSync(layout.coreUpdateTransactionFile, "{ broken");
    assert.throws(() => readCoreUpdateTransaction(layout), /not valid JSON/);

    fs.writeFileSync(
      layout.coreUpdateTransactionFile,
      JSON.stringify({
        version: 1,
        phase: "prepared",
        createdAt: "2026-01-01T00:00:00.000Z",
        previousRecord: null,
        targetRecord: {
          coreVersion: "v2",
          installedAt: "2026-01-01T00:00:00.000Z",
        },
        deferredHealth: true,
        extra: true,
      }),
    );
    assert.throws(() => readCoreUpdateTransaction(layout), /invalid version.*shape/);

    fs.writeFileSync(
      layout.coreUpdateTransactionFile,
      JSON.stringify({
        version: 2,
        phase: "repair-prepared",
        createdAt: "2026-01-01T00:00:00.000Z",
        previousRecord: null,
        targetRecord: {
          coreVersion: "v2",
          installedAt: "2026-01-01T00:00:00.000Z",
        },
        deferredHealth: true,
        repair: { binaryExisted: false, installRecordExisted: false },
      }),
    );
    assert.throws(() => readCoreUpdateTransaction(layout), /repair snapshot/);

    fs.writeFileSync(layout.coreUpdateTransactionFile, "x".repeat(16 * 1024 + 1));
    assert.throws(() => readCoreUpdateTransaction(layout), /exceeds/);

    fs.rmSync(layout.coreUpdateTransactionFile);
    fs.mkdirSync(layout.coreUpdateTransactionFile);
    assert.throws(() => readCoreUpdateTransaction(layout), /not a regular file/);
  });

  it("recovers a legacy backup when the canonical executable is missing", () => {
    seed();
    fs.renameSync(layout.coreExe, `${layout.coreExe}.bak`);

    recoverCoreUpdateTransaction(layout, verify);

    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), false);
  });

  it("rolls a legacy candidate back when only the backup matches install metadata", () => {
    seed();
    fs.renameSync(layout.coreExe, `${layout.coreExe}.bak`);
    fs.writeFileSync(layout.coreExe, "v2-core");

    recoverCoreUpdateTransaction(layout, verify);

    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), false);
  });

  it("finalizes a legacy backup only when the canonical executable already matches", () => {
    seed();
    fs.writeFileSync(`${layout.coreExe}.bak`, "v1-core");

    finalizeCoreUpdateTransaction(layout, verify);

    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), false);
  });

  it("preserves ambiguous legacy candidate and backup binaries", () => {
    seed();
    fs.writeFileSync(layout.coreExe, "v2-core");
    fs.writeFileSync(`${layout.coreExe}.bak`, "v3-core");

    assert.throws(
      () => recoverCoreUpdateTransaction(layout, verify),
      /Cannot determine a safe Core/,
    );

    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v2-core");
    assert.equal(fs.readFileSync(`${layout.coreExe}.bak`, "utf8"), "v3-core");
  });
});
