import fs from "node:fs";
import { type StagedCore, verifyCoreExecutable } from "./core.js";
import {
  type InstallRecord,
  installRecordsEqual,
  parseInstallRecord,
  readInstallRecord,
  writeInstallRecord,
} from "./core-install-record.js";
import { assertCoreBinaryDigest } from "./core-integrity.js";
import {
  atomicWriteFileSync,
  durableRemoveFileSync,
  durableRenameSync,
  pathEntryExists,
} from "./fs-atomic.js";
import { hasExactOwnKeys, isPlainObject } from "./json-shape.js";
import type { SashLayout } from "./paths.js";
import { waitForBinaryUnlocked } from "./process.js";

/** The only upgrade journal: executable and install metadata, never profiles or settings. */
export interface CoreUpdateTransaction {
  version: 1;
  phase: "prepared" | "swapped" | "verified";
  previous: InstallRecord | null;
  target: InstallRecord;
}

export interface CoreUpdateRuntime {
  wasRunning: boolean;
  stop(): Promise<void>;
  startAndVerify(version: string): Promise<void>;
  applySystemProxy(): Promise<void>;
}

export interface CoreUpdateOptions {
  layout: SashLayout;
  staged: StagedCore;
  runtime: CoreUpdateRuntime;
  verifyExecutable?: (exe: string, expectedVersion: string) => void;
}

export interface CoreUpdateResult {
  version: string;
}
function verifyBinary(file: string, record: Pick<InstallRecord, "sha256">): void {
  assertCoreBinaryDigest(file, record.sha256);
}

function defaultVerifier(exe: string, version: string): void {
  verifyCoreExecutable(exe, 5000, version);
}

export function readCoreUpdateTransaction(layout: SashLayout): CoreUpdateTransaction | undefined {
  let text: string;
  try {
    const stat = fs.lstatSync(layout.coreUpdateTransactionFile);
    if (!stat.isFile() || stat.size > 16 * 1024)
      throw new Error("Core update journal must be a bounded regular file");
    text = fs.readFileSync(layout.coreUpdateTransactionFile, "utf8");
    if (Buffer.byteLength(text) > 16 * 1024) throw new Error("Core update journal is too large");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (
    !isPlainObject(value) ||
    !hasExactOwnKeys(value, ["version", "phase", "previous", "target"]) ||
    value.version !== 1 ||
    typeof value.phase !== "string" ||
    !["prepared", "swapped", "verified"].includes(value.phase)
  ) {
    throw new Error("Invalid Core update journal");
  }
  const previous = value.previous === null ? null : parseInstallRecord(value.previous);
  const target = parseInstallRecord(value.target);
  if (previous === undefined || !target) throw new Error("Invalid Core update install records");
  return { version: 1, phase: value.phase as CoreUpdateTransaction["phase"], previous, target };
}

export function writeCoreUpdateTransaction(
  layout: SashLayout,
  transaction: CoreUpdateTransaction,
): void {
  atomicWriteFileSync(
    layout.coreUpdateTransactionFile,
    `${JSON.stringify(transaction, null, 2)}\n`,
  );
}

function clearJournal(layout: SashLayout): void {
  durableRemoveFileSync(layout.coreUpdateTransactionFile);
}

function restoreFiles(layout: SashLayout, transaction: CoreUpdateTransaction): void {
  const backup = `${layout.coreExe}.bak`;
  if (transaction.previous) {
    if (pathEntryExists(backup)) {
      verifyBinary(backup, transaction.previous);
      if (pathEntryExists(layout.coreExe)) {
        verifyBinary(layout.coreExe, transaction.target);
        durableRemoveFileSync(layout.coreExe);
      }
      durableRenameSync(backup, layout.coreExe);
    } else {
      // Also covers interruption after restoring the binary but before its metadata.
      verifyBinary(layout.coreExe, transaction.previous);
    }
    writeInstallRecord(transaction.previous, layout);
  } else {
    if (pathEntryExists(backup)) throw new Error("Unexpected Core backup for a first install");
    if (pathEntryExists(layout.coreExe)) {
      verifyBinary(layout.coreExe, transaction.target);
      durableRemoveFileSync(layout.coreExe);
    }
    if (pathEntryExists(layout.installFile)) {
      if (!installRecordsEqual(readInstallRecord(layout), transaction.target))
        throw new Error("Unrecognized Core install metadata; preserved for inspection");
      durableRemoveFileSync(layout.installFile);
    }
  }
}

function finishVerified(layout: SashLayout, transaction: CoreUpdateTransaction): void {
  verifyBinary(layout.coreExe, transaction.target);
  if (!installRecordsEqual(readInstallRecord(layout), transaction.target))
    throw new Error("Verified Core install metadata changed");
  const backup = `${layout.coreExe}.bak`;
  if (pathEntryExists(backup)) {
    if (!transaction.previous) throw new Error("Unexpected backup for a first install");
    verifyBinary(backup, transaction.previous);
    durableRemoveFileSync(backup);
  }
  clearJournal(layout);
}

/** Called by the daemon after proxy recovery and verified orphan termination. */
export function recoverCoreUpdateTransaction(layout: SashLayout): void {
  const transaction = readCoreUpdateTransaction(layout);
  if (!transaction) {
    if (pathEntryExists(`${layout.coreExe}.bak`))
      throw new Error("Core backup has no ownership journal; preserved for inspection");
    return;
  }
  if (transaction.phase === "verified") finishVerified(layout, transaction);
  else {
    restoreFiles(layout, transaction);
    clearJournal(layout);
  }
}

/** Every install/update completes a real health check in this operation. */
export async function commitCoreUpdate(options: CoreUpdateOptions): Promise<CoreUpdateResult> {
  const { layout, staged, runtime } = options;
  const verify = options.verifyExecutable ?? defaultVerifier;
  if (readCoreUpdateTransaction(layout) || pathEntryExists(`${layout.coreExe}.bak`)) {
    throw new Error("An unfinished Core update requires recovery before another update");
  }
  const previous = readInstallRecord(layout) ?? null;
  if (
    pathEntryExists(layout.coreExe) !== Boolean(previous) ||
    pathEntryExists(layout.installFile) !== Boolean(previous)
  ) {
    throw new Error(
      "Core installation is inconsistent; preserve its files and reinstall into a clean data directory",
    );
  }
  if (previous) verifyBinary(layout.coreExe, previous);
  verifyBinary(staged.exe, staged);
  verify(staged.exe, staged.version);
  await runtime.stop();
  let transaction: CoreUpdateTransaction = {
    version: 1,
    phase: "prepared",
    previous,
    target: {
      coreVersion: staged.version,
      installedAt: new Date().toISOString(),
      sha256: staged.sha256,
    },
  };
  let committed = false;
  try {
    writeCoreUpdateTransaction(layout, transaction);
    await waitForBinaryUnlocked(layout.coreExe);
    if (previous) durableRenameSync(layout.coreExe, `${layout.coreExe}.bak`);
    durableRenameSync(staged.exe, layout.coreExe);
    writeInstallRecord(transaction.target, layout);
    transaction = { ...transaction, phase: "swapped" };
    writeCoreUpdateTransaction(layout, transaction);
    await runtime.startAndVerify(staged.version);
    if (runtime.wasRunning) await runtime.applySystemProxy();
    else await runtime.stop();
    transaction = { ...transaction, phase: "verified" };
    writeCoreUpdateTransaction(layout, transaction);
    committed = true;
    finishVerified(layout, transaction);
    return { version: staged.version };
  } catch (error) {
    if (committed || readCoreUpdateTransaction(layout)?.phase === "verified") throw error;
    try {
      // Never replace a binary while candidate termination is uncertain.
      await runtime.stop();
      const journal = readCoreUpdateTransaction(layout);
      if (journal) restoreFiles(layout, journal);
      if (runtime.wasRunning && previous) {
        await runtime.startAndVerify(previous.coreVersion);
        await runtime.applySystemProxy();
      }
      clearJournal(layout);
    } catch (rollback) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; Core rollback failed: ${rollback instanceof Error ? rollback.message : String(rollback)}`,
        { cause: error },
      );
    }
    throw error;
  }
}
