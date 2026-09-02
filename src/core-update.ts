import fs from "node:fs";
import type { InstallRecord, StagedCore } from "./core.js";
import {
  readInstallRecord,
  validateCoreReleaseTag,
  verifyCoreExecutable,
  writeInstallRecord,
} from "./core.js";
import { atomicWriteFileSync, durableRemoveFileSync, durableRenameSync } from "./fs-atomic.js";
import type { SashLayout } from "./paths.js";
import { waitForBinaryUnlocked } from "./process.js";

const UPDATE_TRANSACTION_VERSION = 1;
const UPDATE_TRANSACTION_SIZE_LIMIT = 16 * 1024;

export type CoreUpdateTransactionPhase = "prepared" | "swapped" | "health-verified";

export interface CoreUpdateTransaction {
  version: 1;
  phase: CoreUpdateTransactionPhase;
  createdAt: string;
  previousRecord: InstallRecord | null;
  targetRecord: InstallRecord;
  /** True when only a later managed Core start may provide the runtime health check. */
  deferredHealth: boolean;
}

export interface CoreUpdateRuntime {
  /** Whether this transaction must launch and health-check the installed binary now. */
  verifyRuntime: boolean;
  stop(): Promise<void>;
  /** Start the installed binary and verify the expected installed version. */
  startAndVerify(expectedVersion: string): Promise<void>;
}

export interface CoreUpdateResult {
  version: string;
  backupRemoved: boolean;
  pendingStartupValidation: boolean;
}

export interface CoreUpdateOptions {
  layout: SashLayout;
  staged: StagedCore;
  runtime?: CoreUpdateRuntime;
  verifyExecutable?: (exe: string, expectedVersion: string) => void;
}

type CoreExecutableVerifier = (exe: string, expectedVersion: string) => void;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function parseInstallRecord(value: unknown): InstallRecord | undefined {
  if (!isPlainObject(value) || !hasExactKeys(value, ["coreVersion", "installedAt"])) {
    return undefined;
  }
  if (typeof value.coreVersion !== "string" || !isCanonicalTimestamp(value.installedAt)) {
    return undefined;
  }
  try {
    return {
      coreVersion: validateCoreReleaseTag(value.coreVersion),
      installedAt: value.installedAt,
    };
  } catch {
    return undefined;
  }
}

function parseTransaction(value: unknown): CoreUpdateTransaction | undefined {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "createdAt",
      "deferredHealth",
      "phase",
      "previousRecord",
      "targetRecord",
      "version",
    ]) ||
    value.version !== UPDATE_TRANSACTION_VERSION ||
    (value.phase !== "prepared" &&
      value.phase !== "swapped" &&
      value.phase !== "health-verified") ||
    !isCanonicalTimestamp(value.createdAt) ||
    typeof value.deferredHealth !== "boolean"
  ) {
    return undefined;
  }
  let previousRecord: InstallRecord | null = null;
  if (value.previousRecord !== null) {
    const parsedPrevious = parseInstallRecord(value.previousRecord);
    if (!parsedPrevious) return undefined;
    previousRecord = parsedPrevious;
  }
  const targetRecord = parseInstallRecord(value.targetRecord);
  if (!targetRecord || targetRecord.installedAt !== value.createdAt) return undefined;
  return {
    version: 1,
    phase: value.phase,
    createdAt: value.createdAt,
    previousRecord,
    targetRecord,
    deferredHealth: value.deferredHealth,
  };
}

function pathEntryExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function recordsEqual(left: InstallRecord | undefined, right: InstallRecord | null): boolean {
  if (!left || !right) return left === undefined && right === null;
  return left.coreVersion === right.coreVersion && left.installedAt === right.installedAt;
}

function backupPath(layout: SashLayout): string {
  return `${layout.coreExe}.bak`;
}

function defaultVerifier(exe: string, expectedVersion: string): void {
  verifyCoreExecutable(exe, 5000, expectedVersion);
}

function verifyTransactionBinary(
  file: string,
  expectedVersion: string,
  verifier: CoreExecutableVerifier,
  role: string,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    throw new Error(`${role} is missing: ${file}: ${(err as Error).message}`);
  }
  if (!stat.isFile()) throw new Error(`${role} is not a regular file: ${file}`);
  try {
    verifier(file, expectedVersion);
  } catch (err) {
    throw new Error(
      `${role} does not match expected version ${expectedVersion}: ${file}: ${(err as Error).message}`,
    );
  }
}

function writeTransaction(transaction: CoreUpdateTransaction, layout: SashLayout): void {
  atomicWriteFileSync(
    layout.coreUpdateTransactionFile,
    `${JSON.stringify(transaction, null, 2)}\n`,
  );
}

export function readCoreUpdateTransaction(layout: SashLayout): CoreUpdateTransaction | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(layout.coreUpdateTransactionFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Cannot inspect Core update transaction ${layout.coreUpdateTransactionFile}: ${(err as Error).message}`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(
      `Core update transaction is not a regular file: ${layout.coreUpdateTransactionFile}`,
    );
  }
  if (stat.size > UPDATE_TRANSACTION_SIZE_LIMIT) {
    throw new Error(
      `Core update transaction exceeds ${UPDATE_TRANSACTION_SIZE_LIMIT} bytes: ${layout.coreUpdateTransactionFile}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(layout.coreUpdateTransactionFile, "utf8")) as unknown;
  } catch (err) {
    throw new Error(
      `Core update transaction is not valid JSON: ${layout.coreUpdateTransactionFile} (${(err as Error).message})`,
    );
  }
  const transaction = parseTransaction(parsed);
  if (!transaction) {
    throw new Error(
      `Core update transaction has an invalid version, phase, timestamp, records, or shape: ${layout.coreUpdateTransactionFile}`,
    );
  }
  return transaction;
}

export function beginCoreUpdateTransaction(
  layout: SashLayout,
  targetVersion: string,
  previousRecord: InstallRecord | undefined,
  deferredHealth: boolean,
  createdAt = new Date().toISOString(),
): CoreUpdateTransaction {
  const targetRecord = {
    coreVersion: validateCoreReleaseTag(targetVersion),
    installedAt: createdAt,
  };
  if (!isCanonicalTimestamp(createdAt)) {
    throw new Error(`Invalid Core update timestamp: ${createdAt}`);
  }
  if (readCoreUpdateTransaction(layout)) {
    throw new Error(
      `A Core update transaction is already pending: ${layout.coreUpdateTransactionFile}`,
    );
  }
  if (pathEntryExists(backupPath(layout))) {
    throw new Error(`Previous Core backup still exists: ${backupPath(layout)}`);
  }
  const currentExists = pathEntryExists(layout.coreExe);
  if (currentExists !== Boolean(previousRecord)) {
    throw new Error("Cannot begin Core update with inconsistent binary/install metadata state");
  }
  const transaction: CoreUpdateTransaction = {
    version: 1,
    phase: "prepared",
    createdAt,
    previousRecord: previousRecord ?? null,
    targetRecord,
    deferredHealth,
  };
  writeTransaction(transaction, layout);
  return transaction;
}

function assertSameTransaction(
  expected: CoreUpdateTransaction,
  current: CoreUpdateTransaction | undefined,
): asserts current is CoreUpdateTransaction {
  if (
    !current ||
    current.createdAt !== expected.createdAt ||
    current.targetRecord.coreVersion !== expected.targetRecord.coreVersion ||
    current.targetRecord.installedAt !== expected.targetRecord.installedAt
  ) {
    throw new Error("Core update transaction changed during publication");
  }
}

export function markCoreUpdateSwapped(
  transaction: CoreUpdateTransaction,
  layout: SashLayout,
): CoreUpdateTransaction {
  const current = readCoreUpdateTransaction(layout);
  assertSameTransaction(transaction, current);
  if (current.phase !== "prepared") throw new Error("Core update is not ready to mark swapped");
  const swapped: CoreUpdateTransaction = { ...current, phase: "swapped" };
  writeTransaction(swapped, layout);
  return swapped;
}

export function markCoreUpdateHealthVerified(
  transaction: CoreUpdateTransaction,
  layout: SashLayout,
): CoreUpdateTransaction {
  const current = readCoreUpdateTransaction(layout);
  assertSameTransaction(transaction, current);
  if (current.phase !== "swapped") {
    throw new Error("Core update is not ready to mark health-verified");
  }
  const verified: CoreUpdateTransaction = { ...current, phase: "health-verified" };
  writeTransaction(verified, layout);
  return verified;
}

export function clearCoreUpdateTransaction(layout: SashLayout): void {
  durableRemoveFileSync(layout.coreUpdateTransactionFile);
}

function restoreInstallRecord(record: InstallRecord | null, layout: SashLayout): void {
  if (record) writeInstallRecord(record, layout);
  else durableRemoveFileSync(layout.installFile);
}

/** Restore the exact pre-update binary and metadata, preserving ambiguous states. */
export function rollbackCoreUpdateTransaction(
  layout: SashLayout,
  verifier: CoreExecutableVerifier = defaultVerifier,
): InstallRecord | null | undefined {
  const transaction = readCoreUpdateTransaction(layout);
  if (!transaction) return undefined;
  const backup = backupPath(layout);
  const currentExists = pathEntryExists(layout.coreExe);
  const backupExists = pathEntryExists(backup);

  if (transaction.previousRecord) {
    if (backupExists) {
      verifyTransactionBinary(
        backup,
        transaction.previousRecord.coreVersion,
        verifier,
        "Core rollback backup",
      );
      if (currentExists) {
        verifyTransactionBinary(
          layout.coreExe,
          transaction.targetRecord.coreVersion,
          verifier,
          "Core update candidate",
        );
        durableRemoveFileSync(layout.coreExe);
      }
      durableRenameSync(backup, layout.coreExe);
    } else {
      if (!currentExists) {
        throw new Error("Core update rollback has neither the previous binary nor its backup");
      }
      verifyTransactionBinary(
        layout.coreExe,
        transaction.previousRecord.coreVersion,
        verifier,
        "Previous Core binary",
      );
    }
  } else {
    if (backupExists) {
      throw new Error(
        `Unexpected rollback backup for an update without a previous Core: ${backup}`,
      );
    }
    if (currentExists) {
      verifyTransactionBinary(
        layout.coreExe,
        transaction.targetRecord.coreVersion,
        verifier,
        "Core update candidate",
      );
      durableRemoveFileSync(layout.coreExe);
    }
  }

  restoreInstallRecord(transaction.previousRecord, layout);
  clearCoreUpdateTransaction(layout);
  return transaction.previousRecord;
}

function validatePendingTransaction(
  transaction: CoreUpdateTransaction,
  layout: SashLayout,
  verifier: CoreExecutableVerifier,
): void {
  verifyTransactionBinary(
    layout.coreExe,
    transaction.targetRecord.coreVersion,
    verifier,
    "Pending Core update candidate",
  );
  const backup = backupPath(layout);
  if (transaction.previousRecord) {
    if (pathEntryExists(backup)) {
      verifyTransactionBinary(
        backup,
        transaction.previousRecord.coreVersion,
        verifier,
        "Pending Core rollback backup",
      );
    } else if (transaction.phase !== "health-verified") {
      throw new Error(`Pending Core update is missing its rollback backup: ${backup}`);
    }
  } else if (pathEntryExists(backup)) {
    throw new Error(`Pending first Core update has an unexpected rollback backup: ${backup}`);
  }

  const currentRecord = readInstallRecord(layout);
  if (!currentRecord && pathEntryExists(layout.installFile)) {
    throw new Error("Pending Core update install metadata is malformed or non-regular");
  }
  const recordMatchesPhase =
    transaction.phase === "health-verified"
      ? recordsEqual(currentRecord, transaction.targetRecord) ||
        recordsEqual(currentRecord, transaction.previousRecord)
      : recordsEqual(currentRecord, transaction.previousRecord ?? transaction.targetRecord);
  if (!recordMatchesPhase) {
    throw new Error("Pending Core update install metadata does not match its journal phase");
  }
}

/**
 * Recover crash phases. Deferred or already health-verified candidates remain
 * pending so only a managed start/restoration can consume the rollback slot.
 */
export function recoverCoreUpdateTransaction(
  layout: SashLayout,
  verifier: CoreExecutableVerifier = defaultVerifier,
): CoreUpdateTransaction | undefined {
  const transaction = readCoreUpdateTransaction(layout);
  if (!transaction) {
    recoverLegacyInterruptedCoreUpdate(layout, verifier);
    return undefined;
  }
  if (
    transaction.phase === "prepared" ||
    (!transaction.deferredHealth && transaction.phase === "swapped")
  ) {
    rollbackCoreUpdateTransaction(layout, verifier);
    return undefined;
  }
  validatePendingTransaction(transaction, layout, verifier);
  if (transaction.phase === "health-verified") {
    writeInstallRecord(transaction.targetRecord, layout);
  }
  return transaction;
}

/** Target version expected while a journaled candidate owns the canonical executable. */
export function pendingCoreUpdateVersion(layout: SashLayout): string | undefined {
  const transaction = readCoreUpdateTransaction(layout);
  return transaction && transaction.phase !== "prepared"
    ? transaction.targetRecord.coreVersion
    : undefined;
}

/** Commit a successful managed start and consume its retained rollback slot. */
export function completePendingCoreUpdateAfterStart(
  layout: SashLayout,
  verifier: CoreExecutableVerifier = defaultVerifier,
): string | undefined {
  let transaction = readCoreUpdateTransaction(layout);
  if (!transaction) return undefined;
  if (transaction.phase === "prepared") {
    throw new Error("Cannot complete a Core update which has not been swapped");
  }
  validatePendingTransaction(transaction, layout, verifier);
  if (transaction.phase === "swapped") {
    if (!transaction.deferredHealth) {
      throw new Error(
        "Cannot complete a Core update whose in-command health check was interrupted",
      );
    }
    transaction = markCoreUpdateHealthVerified(transaction, layout);
  }
  writeInstallRecord(transaction.targetRecord, layout);
  durableRemoveFileSync(backupPath(layout));
  clearCoreUpdateTransaction(layout);
  return transaction.targetRecord.coreVersion;
}

/** Finalize an update already proven healthy after external runtime restoration. */
export function finalizeCoreUpdateTransaction(
  layout: SashLayout,
  verifier: CoreExecutableVerifier = defaultVerifier,
): void {
  const transaction = readCoreUpdateTransaction(layout);
  if (!transaction) {
    recoverLegacyInterruptedCoreUpdate(layout, verifier, true);
    return;
  }
  if (transaction.phase !== "health-verified") {
    throw new Error(
      `Core update still requires a health check: ${transaction.targetRecord.coreVersion}`,
    );
  }
  validatePendingTransaction(transaction, layout, verifier);
  writeInstallRecord(transaction.targetRecord, layout);
  durableRemoveFileSync(backupPath(layout));
  clearCoreUpdateTransaction(layout);
}

/**
 * Atomically replace the installed Core. Runtime-verified updates retain their
 * rollback slot until the caller restores the original daemon/Core state;
 * stopped updates retain it until the next successful managed Core start.
 */
export async function commitCoreUpdate(opts: CoreUpdateOptions): Promise<CoreUpdateResult> {
  try {
    return await commitCoreUpdateUnlocked(opts);
  } finally {
    fs.rmSync(opts.staged.exe, { force: true });
  }
}

async function commitCoreUpdateUnlocked(opts: CoreUpdateOptions): Promise<CoreUpdateResult> {
  const { layout, staged, runtime } = opts;
  const verifier = opts.verifyExecutable ?? defaultVerifier;
  if (readCoreUpdateTransaction(layout)) recoverCoreUpdateTransaction(layout, verifier);
  else recoverLegacyInterruptedCoreUpdate(layout, verifier, true);
  if (readCoreUpdateTransaction(layout)) {
    throw new Error(
      `A Core update is pending managed startup/finalization: ${layout.coreUpdateTransactionFile}`,
    );
  }

  const previousRecord = readInstallRecord(layout);
  const hadCurrent = pathEntryExists(layout.coreExe);
  if (hadCurrent !== Boolean(previousRecord)) {
    throw new Error("Cannot update inconsistent Core binary/install metadata state");
  }
  const deferredHealth = runtime?.verifyRuntime !== true;
  let transaction = beginCoreUpdateTransaction(
    layout,
    staged.version,
    previousRecord,
    deferredHealth,
  );
  let swapped = false;
  let runtimeStopped = false;
  let rollbackError: Error | undefined;

  try {
    if (runtime?.verifyRuntime) {
      await runtime.stop();
      runtimeStopped = true;
    }

    const backup = backupPath(layout);
    if (hadCurrent) {
      await waitForBinaryUnlocked(layout.coreExe);
      durableRenameSync(layout.coreExe, backup);
    }
    durableRenameSync(staged.exe, layout.coreExe);
    swapped = true;
    transaction = markCoreUpdateSwapped(transaction, layout);
    if (deferredHealth && !previousRecord) writeInstallRecord(transaction.targetRecord, layout);

    if (runtime?.verifyRuntime) {
      await runtime.startAndVerify(staged.version);
      transaction = markCoreUpdateHealthVerified(transaction, layout);
      writeInstallRecord(transaction.targetRecord, layout);
    }

    return {
      version: staged.version,
      backupRemoved: !pathEntryExists(backup),
      pendingStartupValidation: deferredHealth,
    };
  } catch (err) {
    try {
      if (runtime?.verifyRuntime && swapped) {
        await runtime.stop();
        runtimeStopped = true;
      }
      const restored = rollbackCoreUpdateTransaction(layout, verifier);
      if (runtime?.verifyRuntime && runtimeStopped && restored) {
        await runtime.startAndVerify(restored.coreVersion);
      }
    } catch (rollbackErr) {
      rollbackError = rollbackErr as Error;
    }

    const message = (err as Error).message;
    if (rollbackError) {
      throw new Error(`${message}; rollback also failed: ${rollbackError.message}`);
    }
    throw err;
  }
}

/** Legacy `.bak` recovery for states created before the journal existed. */
function recoverLegacyInterruptedCoreUpdate(
  layout: SashLayout,
  verifier: CoreExecutableVerifier = defaultVerifier,
  finalizeCommittedBackup = false,
): void {
  const backup = backupPath(layout);
  if (!pathEntryExists(backup)) return;

  const previousRecord = readInstallRecord(layout);
  if (!previousRecord) {
    throw new Error(`Cannot recover ambiguous Core backup without install metadata: ${backup}`);
  }
  if (!pathEntryExists(layout.coreExe)) {
    verifyTransactionBinary(backup, previousRecord.coreVersion, verifier, "Core backup");
    durableRenameSync(backup, layout.coreExe);
    return;
  }

  let currentMatches = false;
  let backupMatches = false;
  try {
    verifier(layout.coreExe, previousRecord.coreVersion);
    currentMatches = true;
  } catch {
    // Try the rollback slot below.
  }
  if (!currentMatches) {
    try {
      verifier(backup, previousRecord.coreVersion);
      backupMatches = true;
    } catch {
      // Report the ambiguous state below.
    }
  }
  if (currentMatches) {
    if (finalizeCommittedBackup) durableRemoveFileSync(backup);
  } else if (backupMatches) {
    durableRemoveFileSync(layout.coreExe);
    durableRenameSync(backup, layout.coreExe);
  } else {
    throw new Error(
      `Cannot determine a safe Core after an interrupted update; preserved ${layout.coreExe} and ${backup}`,
    );
  }
}

/** Backward-compatible entrypoint; new callers should use recoverCoreUpdateTransaction. */
export function recoverInterruptedCoreUpdate(
  layout: SashLayout,
  verifier: CoreExecutableVerifier = defaultVerifier,
  finalizeCommittedBackup = false,
): void {
  const transaction = readCoreUpdateTransaction(layout);
  if (transaction) {
    recoverCoreUpdateTransaction(layout, verifier);
    return;
  }
  recoverLegacyInterruptedCoreUpdate(layout, verifier, finalizeCommittedBackup);
}

/** Backward-compatible finalizer for update callers. */
export function finalizeCoreUpdateBackup(layout: SashLayout): void {
  finalizeCoreUpdateTransaction(layout);
}
