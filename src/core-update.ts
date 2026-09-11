import fs from "node:fs";
import type { StagedCore } from "./core.js";
import { assertCoreBinaryFile } from "./core-binary.js";
import {
  type InstallRecord,
  parseInstallRecord,
  readInstallRecord,
  writeInstallRecord,
} from "./core-install-record.js";
import { errorMessage } from "./error-utils.js";
import {
  atomicWriteFileSync,
  durableRemoveFileSync,
  durableRenameSync,
  pathEntryExists,
} from "./fs-atomic.js";
import { isPlainObject } from "./json-shape.js";
import type { SashLayout } from "./paths.js";
import { waitForBinaryUnlocked } from "./process.js";

/** The only upgrade journal: executable and install metadata, never profiles or settings. */
export interface CoreUpdateTransaction {
  previous: InstallRecord | null;
  target: InstallRecord;
  /** Set once the new binary passed its health check; cleanup may still be pending. */
  verified?: boolean;
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
}

export interface CoreUpdateResult {
  version: string;
}

/**
 * Lenient read: a damaged journal reads as absent, so it can never block daemon
 * startup; the `.bak` binary and the committed install record decide recovery.
 */
export function readCoreUpdateTransaction(layout: SashLayout): CoreUpdateTransaction | undefined {
  let text: string;
  try {
    text = fs.readFileSync(layout.coreUpdateTransactionFile, "utf8");
  } catch {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isPlainObject(value)) throw new Error("Not an object");
    const previous = value.previous === null ? null : parseInstallRecord(value.previous);
    const target = parseInstallRecord(value.target);
    if (previous === undefined || !target) throw new Error("Missing install records");
    return {
      previous,
      target,
      // Legacy journals recorded the phase as "verified" instead of a flag.
      ...(value.verified === true || value.phase === "verified" ? { verified: true } : {}),
    };
  } catch {
    return undefined;
  }
}

function writeCoreUpdateTransaction(layout: SashLayout, transaction: CoreUpdateTransaction): void {
  atomicWriteFileSync(
    layout.coreUpdateTransactionFile,
    `${JSON.stringify(transaction, null, 2)}\n`,
  );
}

function clearJournal(layout: SashLayout): void {
  durableRemoveFileSync(layout.coreUpdateTransactionFile);
}

/**
 * Roll a possibly-swapped installation back to its recorded previous state.
 * A missing backup only means the swap never began or had already been rolled
 * back, so the recorded previous state is written either way.
 */
function restoreTransaction(layout: SashLayout, transaction: CoreUpdateTransaction): void {
  const backup = `${layout.coreExe}.bak`;
  if (transaction.previous) {
    if (pathEntryExists(backup)) {
      if (pathEntryExists(layout.coreExe)) durableRemoveFileSync(layout.coreExe);
      durableRenameSync(backup, layout.coreExe);
    }
    writeInstallRecord(transaction.previous, layout);
  } else {
    if (pathEntryExists(backup)) throw new Error("Unexpected Core backup for a first install");
    if (pathEntryExists(layout.coreExe)) durableRemoveFileSync(layout.coreExe);
    if (pathEntryExists(layout.installFile)) {
      if (readInstallRecord(layout)?.coreVersion !== transaction.target.coreVersion)
        throw new Error("Unrecognized Core install metadata; preserved for inspection");
      durableRemoveFileSync(layout.installFile);
    }
  }
  clearJournal(layout);
}

/** The new binary passed its health check; only cleanup can still be pending. */
function finishVerified(layout: SashLayout, transaction: CoreUpdateTransaction): void {
  try {
    const backup = `${layout.coreExe}.bak`;
    if (pathEntryExists(backup)) {
      if (!transaction.previous) throw new Error("Unexpected backup for a first install");
      durableRemoveFileSync(backup);
    }
    clearJournal(layout);
  } catch (error) {
    console.warn(
      `[sashd] Core update succeeded; cleanup retained for retry: ${errorMessage(error)}`,
    );
  }
}

/** Called by the daemon after proxy recovery and verified orphan termination. */
export function recoverCoreUpdateTransaction(layout: SashLayout): void {
  const transaction = readCoreUpdateTransaction(layout);
  if (!transaction) {
    if (pathEntryExists(`${layout.coreExe}.bak`))
      throw new Error("Core backup has no ownership journal; preserved for inspection");
    return;
  }
  if (transaction.verified) finishVerified(layout, transaction);
  else restoreTransaction(layout, transaction);
}

/** Every install/update completes a real health check in this operation. */
export async function commitCoreUpdate(options: CoreUpdateOptions): Promise<CoreUpdateResult> {
  const { layout, staged, runtime } = options;
  if (readCoreUpdateTransaction(layout)) recoverCoreUpdateTransaction(layout);
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
  if (previous) assertCoreBinaryFile(layout.coreExe);
  assertCoreBinaryFile(staged.exe);
  fs.mkdirSync(layout.binDir, { recursive: true });
  await runtime.stop();
  const transaction: CoreUpdateTransaction = {
    previous,
    target: { coreVersion: staged.version },
  };
  try {
    writeCoreUpdateTransaction(layout, transaction);
    await waitForBinaryUnlocked(layout.coreExe);
    if (previous) durableRenameSync(layout.coreExe, `${layout.coreExe}.bak`);
    durableRenameSync(staged.exe, layout.coreExe);
    writeInstallRecord(transaction.target, layout);
    await runtime.startAndVerify(staged.version);
    if (runtime.wasRunning) await runtime.applySystemProxy();
    else await runtime.stop();
    writeCoreUpdateTransaction(layout, { ...transaction, verified: true });
    finishVerified(layout, transaction);
    return { version: staged.version };
  } catch (error) {
    try {
      // Never replace a binary while candidate termination is uncertain.
      await runtime.stop();
      restoreTransaction(layout, transaction);
      if (runtime.wasRunning && previous) {
        await runtime.startAndVerify(previous.coreVersion);
        await runtime.applySystemProxy();
      }
    } catch (rollback) {
      throw new Error(`${errorMessage(error)}; Core rollback failed: ${errorMessage(rollback)}`, {
        cause: error,
      });
    }
    throw error;
  }
}
