import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readInstallRecord, writeInstallRecord } from "./core.js";
import {
  beginCoreUpdateTransaction,
  type CoreUpdateRuntime,
  commitCoreUpdate,
  completePendingCoreUpdateAfterStart,
  finalizeCoreUpdateTransaction,
  markCoreUpdateHealthVerified,
  markCoreUpdateSwapped,
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

    fs.writeFileSync(layout.coreUpdateTransactionFile, "x".repeat(16 * 1024 + 1));
    assert.throws(() => readCoreUpdateTransaction(layout), /exceeds/);

    fs.rmSync(layout.coreUpdateTransactionFile);
    fs.mkdirSync(layout.coreUpdateTransactionFile);
    assert.throws(() => readCoreUpdateTransaction(layout), /not a regular file/);
  });
});
