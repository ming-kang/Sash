import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readInstallRecord, writeInstallRecord } from "./core.js";
import {
  beginCoreUpdateTransaction,
  commitCoreUpdate,
  markCoreUpdateHealthVerified,
  markCoreUpdateSwapped,
  readCoreUpdateTransaction,
} from "./core-update.js";
import {
  completeCoordinatedCoreUpdateAfterStart,
  finalizeCoordinatedCoreUpdate,
  recoverCoordinatedCoreUpdate,
  rollbackCoordinatedCoreUpdate,
} from "./core-update-coordination.js";
import {
  markRetainedManagedStateTransactionCommitted,
  readManagedStateTransactionStatus,
  retainManagedStateTransaction,
} from "./managed-state-transaction.js";
import { type SashLayout, sashLayout } from "./paths.js";

describe("coordinated Core update recovery", () => {
  let root: string;
  let layout: SashLayout;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sash-core-update-coordination-test-"));
    layout = sashLayout(root);
    fs.mkdirSync(layout.binDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function verify(exe: string, expectedVersion: string): void {
    if (fs.readFileSync(exe, "utf8") !== `${expectedVersion}-core`) {
      throw new Error("version mismatch");
    }
  }

  function seed(version = "v1"): void {
    fs.writeFileSync(layout.coreExe, `${version}-core`);
    writeInstallRecord({ coreVersion: version, installedAt: "2026-01-01T00:00:00.000Z" }, layout);
    fs.writeFileSync(layout.configFile, "old config");
  }

  function staged(version: string): { version: string; exe: string } {
    const exe = path.join(layout.binDir, `staged-${version}`);
    fs.writeFileSync(exe, `${version}-core`);
    return { version, exe };
  }

  async function retainConfig(): Promise<void> {
    await retainManagedStateTransaction(layout, {
      config: { yaml: "new config", proxyCount: 0, source: "default" },
      reloadRuntime: false,
    });
  }

  it("rolls managed state back when no Core transaction was started", async () => {
    seed();
    await retainConfig();

    assert.equal(recoverCoordinatedCoreUpdate(layout, verify), undefined);

    assert.equal(fs.readFileSync(layout.configFile, "utf8"), "old config");
    assert.equal(readManagedStateTransactionStatus(layout), undefined);
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
  });

  it("keeps a deferred candidate and its matching managed publication", async () => {
    seed();
    await retainConfig();
    await commitCoreUpdate({
      layout,
      staged: staged("v2"),
      verifyExecutable: verify,
    });

    const pending = recoverCoordinatedCoreUpdate(layout, verify);

    assert.equal(pending?.phase, "swapped");
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), "new config");
    assert.equal(readManagedStateTransactionStatus(layout)?.phase, "retained");
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v2-core");
    assert.equal(readInstallRecord(layout)?.coreVersion, "v1");
  });

  it("commits both journals after a deferred candidate starts successfully", async () => {
    seed();
    await retainConfig();
    await commitCoreUpdate({
      layout,
      staged: staged("v2"),
      verifyExecutable: verify,
    });

    assert.equal(completeCoordinatedCoreUpdateAfterStart(layout, verify), "v2");

    assert.equal(readCoreUpdateTransaction(layout), undefined);
    assert.equal(readManagedStateTransactionStatus(layout), undefined);
    assert.equal(readInstallRecord(layout)?.coreVersion, "v2");
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), false);
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), "new config");
  });

  it("rolls managed state back before an interrupted in-command swap", async () => {
    seed();
    await retainConfig();
    const previous = readInstallRecord(layout);
    assert.ok(previous);
    let transaction = beginCoreUpdateTransaction(layout, "v2", previous, false);
    fs.renameSync(layout.coreExe, `${layout.coreExe}.bak`);
    fs.writeFileSync(layout.coreExe, "v2-core");
    transaction = markCoreUpdateSwapped(transaction, layout);

    assert.equal(recoverCoordinatedCoreUpdate(layout, verify), undefined);

    assert.equal(transaction.phase, "swapped");
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), "old config");
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
    assert.equal(readCoreUpdateTransaction(layout), undefined);
    assert.equal(readManagedStateTransactionStatus(layout), undefined);
  });

  it("recovers a durable managed commit decision before clearing snapshots", async () => {
    seed();
    await retainConfig();
    const previous = readInstallRecord(layout);
    assert.ok(previous);
    let transaction = beginCoreUpdateTransaction(layout, "v2", previous, false);
    fs.renameSync(layout.coreExe, `${layout.coreExe}.bak`);
    fs.writeFileSync(layout.coreExe, "v2-core");
    transaction = markCoreUpdateSwapped(transaction, layout);
    markCoreUpdateHealthVerified(transaction, layout);
    markRetainedManagedStateTransactionCommitted(layout);

    assert.equal(recoverCoordinatedCoreUpdate(layout, verify), undefined);

    assert.equal(readInstallRecord(layout)?.coreVersion, "v2");
    assert.equal(readCoreUpdateTransaction(layout), undefined);
    assert.equal(readManagedStateTransactionStatus(layout), undefined);
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), "new config");
  });

  it("finalizes a runtime-verified candidate only after managed commit is durable", async () => {
    seed();
    await retainConfig();
    const previous = readInstallRecord(layout);
    assert.ok(previous);
    let transaction = beginCoreUpdateTransaction(layout, "v2", previous, false);
    fs.renameSync(layout.coreExe, `${layout.coreExe}.bak`);
    fs.writeFileSync(layout.coreExe, "v2-core");
    transaction = markCoreUpdateSwapped(transaction, layout);
    markCoreUpdateHealthVerified(transaction, layout);

    finalizeCoordinatedCoreUpdate(layout, verify);

    assert.equal(readInstallRecord(layout)?.coreVersion, "v2");
    assert.equal(readCoreUpdateTransaction(layout), undefined);
    assert.equal(readManagedStateTransactionStatus(layout), undefined);
    assert.equal(fs.existsSync(`${layout.coreExe}.bak`), false);
  });

  it("rolls both journals back explicitly after candidate failure", async () => {
    seed();
    await retainConfig();
    const previous = readInstallRecord(layout);
    assert.ok(previous);
    let transaction = beginCoreUpdateTransaction(layout, "v2", previous, false);
    fs.renameSync(layout.coreExe, `${layout.coreExe}.bak`);
    fs.writeFileSync(layout.coreExe, "v2-core");
    transaction = markCoreUpdateSwapped(transaction, layout);

    const restored = rollbackCoordinatedCoreUpdate(layout, verify);

    assert.equal(restored?.coreVersion, "v1");
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), "old config");
    assert.equal(fs.readFileSync(layout.coreExe, "utf8"), "v1-core");
    assert.equal(readCoreUpdateTransaction(layout), undefined);
    assert.equal(readManagedStateTransactionStatus(layout), undefined);
  });
});
