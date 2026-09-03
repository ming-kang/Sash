import fs from "node:fs";
import type { StagedCore } from "./core.js";
import { verifyCoreExecutable } from "./core.js";
import {
  type InstallRecord,
  installRecordsEqual,
  parseInstallRecord,
  readInstallRecord,
  validateCoreReleaseTag,
  writeInstallRecord,
} from "./core-install-record.js";
import {
  atomicWriteFileSync,
  durableRemoveFileSync,
  durableRenameSync,
  pathEntryExists,
} from "./fs-atomic.js";
import { hasExactOwnKeys, isCanonicalIsoTimestamp, isPlainObject } from "./json-shape.js";
import type { SashLayout } from "./paths.js";
import { waitForBinaryUnlocked } from "./process.js";

const UPDATE_TRANSACTION_SIZE_LIMIT = 16 * 1024;

export type CoreUpdateTransactionPhase =
  | "repair-prepared"
  | "repair-restoring"
  | "prepared"
  | "swapped"
  | "health-verified";

type NormalCoreUpdatePhase = Exclude<
  CoreUpdateTransactionPhase,
  "repair-prepared" | "repair-restoring"
>;

interface CoreUpdateTransactionBase {
  phase: CoreUpdateTransactionPhase;
  createdAt: string;
  previousRecord: InstallRecord | null;
  targetRecord: InstallRecord;
  /** True when only a later managed Core start may provide the runtime health check. */
  deferredHealth: boolean;
}

export interface NormalCoreUpdateTransaction extends CoreUpdateTransactionBase {
  version: 1;
  phase: NormalCoreUpdatePhase;
}

export interface CoreRepairSnapshot {
  binaryExisted: boolean;
  installRecordExisted: boolean;
}

export interface CoreRepairUpdateTransaction extends CoreUpdateTransactionBase {
  version: 2;
  previousRecord: null;
  repair: CoreRepairSnapshot;
}

export type CoreUpdateTransaction = NormalCoreUpdateTransaction | CoreRepairUpdateTransaction;

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
  /** Explicitly quarantine and replace an inconsistent binary/install pair. */
  forceRepair?: boolean;
  /** Restore coordinated managed state after the candidate has stopped, before binary rollback. */
  beforeRollback?: () => Promise<void> | void;
}

type CoreExecutableVerifier = (exe: string, expectedVersion: string) => void;

function parseTargetRecord(value: unknown, createdAt: string): InstallRecord | undefined {
  const targetRecord = parseInstallRecord(value);
  return targetRecord?.installedAt === createdAt ? targetRecord : undefined;
}

function parseNormalTransaction(value: Record<string, unknown>): CoreUpdateTransaction | undefined {
  if (
    !hasExactOwnKeys(value, [
      "createdAt",
      "deferredHealth",
      "phase",
      "previousRecord",
      "targetRecord",
      "version",
    ]) ||
    value.version !== 1 ||
    (value.phase !== "prepared" &&
      value.phase !== "swapped" &&
      value.phase !== "health-verified") ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
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
  const targetRecord = parseTargetRecord(value.targetRecord, value.createdAt);
  if (!targetRecord) return undefined;
  return {
    version: 1,
    phase: value.phase,
    createdAt: value.createdAt,
    previousRecord,
    targetRecord,
    deferredHealth: value.deferredHealth,
  };
}

function parseRepairTransaction(value: Record<string, unknown>): CoreUpdateTransaction | undefined {
  if (
    !hasExactOwnKeys(value, [
      "createdAt",
      "deferredHealth",
      "phase",
      "previousRecord",
      "repair",
      "targetRecord",
      "version",
    ]) ||
    value.version !== 2 ||
    (value.phase !== "repair-prepared" &&
      value.phase !== "repair-restoring" &&
      value.phase !== "prepared" &&
      value.phase !== "swapped" &&
      value.phase !== "health-verified") ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    typeof value.deferredHealth !== "boolean" ||
    value.previousRecord !== null ||
    !isPlainObject(value.repair) ||
    !hasExactOwnKeys(value.repair, ["binaryExisted", "installRecordExisted"]) ||
    typeof value.repair.binaryExisted !== "boolean" ||
    typeof value.repair.installRecordExisted !== "boolean" ||
    (!value.repair.binaryExisted && !value.repair.installRecordExisted)
  ) {
    return undefined;
  }
  const targetRecord = parseTargetRecord(value.targetRecord, value.createdAt);
  if (!targetRecord) return undefined;
  return {
    version: 2,
    phase: value.phase,
    createdAt: value.createdAt,
    previousRecord: null,
    targetRecord,
    deferredHealth: value.deferredHealth,
    repair: {
      binaryExisted: value.repair.binaryExisted,
      installRecordExisted: value.repair.installRecordExisted,
    },
  };
}

function parseTransaction(value: unknown): CoreUpdateTransaction | undefined {
  if (!isPlainObject(value)) return undefined;
  return value.version === 1
    ? parseNormalTransaction(value)
    : value.version === 2
      ? parseRepairTransaction(value)
      : undefined;
}

function backupPath(layout: SashLayout): string {
  return `${layout.coreExe}.bak`;
}

function repairBinaryBackupPath(layout: SashLayout): string {
  return `${layout.coreExe}.repair.bak`;
}

function repairInstallBackupPath(layout: SashLayout): string {
  return `${layout.installFile}.repair.bak`;
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
      `Core update transaction has an invalid version, phase, timestamp, records, repair snapshot, or shape: ${layout.coreUpdateTransactionFile}`,
    );
  }
  return transaction;
}

function assertRollbackSlotsClear(layout: SashLayout): void {
  for (const file of [
    backupPath(layout),
    repairBinaryBackupPath(layout),
    repairInstallBackupPath(layout),
  ]) {
    if (pathEntryExists(file))
      throw new Error(`Previous Core rollback state still exists: ${file}`);
  }
}

export function beginCoreUpdateTransaction(
  layout: SashLayout,
  targetVersion: string,
  previousRecord: InstallRecord | undefined,
  deferredHealth: boolean,
  createdAt = new Date().toISOString(),
): NormalCoreUpdateTransaction {
  const targetRecord = {
    coreVersion: validateCoreReleaseTag(targetVersion),
    installedAt: createdAt,
  };
  if (!isCanonicalIsoTimestamp(createdAt)) {
    throw new Error(`Invalid Core update timestamp: ${createdAt}`);
  }
  if (readCoreUpdateTransaction(layout)) {
    throw new Error(
      `A Core update transaction is already pending: ${layout.coreUpdateTransactionFile}`,
    );
  }
  assertRollbackSlotsClear(layout);
  const currentExists = pathEntryExists(layout.coreExe);
  const installEntryExists = pathEntryExists(layout.installFile);
  if (currentExists !== Boolean(previousRecord) || installEntryExists !== Boolean(previousRecord)) {
    throw new Error("Cannot begin Core update with inconsistent binary/install metadata state");
  }
  const transaction: NormalCoreUpdateTransaction = {
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

function isRegularFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function assertRepairableCoreEntry(file: string, role: string): void {
  if (!pathEntryExists(file)) return;
  if (fs.lstatSync(file).isDirectory()) {
    throw new Error(`Cannot repair Core installation: ${role} path is a directory: ${file}`);
  }
}

/** Persist the exact inconsistent fixed-role presence before moving either entry. */
export function beginCoreRepairUpdateTransaction(
  layout: SashLayout,
  targetVersion: string,
  deferredHealth: boolean,
  createdAt = new Date().toISOString(),
): CoreRepairUpdateTransaction {
  const targetRecord = {
    coreVersion: validateCoreReleaseTag(targetVersion),
    installedAt: createdAt,
  };
  if (!isCanonicalIsoTimestamp(createdAt)) {
    throw new Error(`Invalid Core update timestamp: ${createdAt}`);
  }
  if (readCoreUpdateTransaction(layout)) {
    throw new Error(
      `A Core update transaction is already pending: ${layout.coreUpdateTransactionFile}`,
    );
  }
  assertRollbackSlotsClear(layout);

  const binaryExisted = pathEntryExists(layout.coreExe);
  const installRecordExisted = pathEntryExists(layout.installFile);
  const previousRecord = readInstallRecord(layout);
  if (
    (!binaryExisted && !installRecordExisted) ||
    (binaryExisted && installRecordExisted && isRegularFile(layout.coreExe) && previousRecord)
  ) {
    throw new Error("Core installation does not require forced repair");
  }
  assertRepairableCoreEntry(layout.coreExe, "executable");
  assertRepairableCoreEntry(layout.installFile, "install metadata");

  const transaction: CoreRepairUpdateTransaction = {
    version: 2,
    phase: "repair-prepared",
    createdAt,
    previousRecord: null,
    targetRecord,
    deferredHealth,
    repair: { binaryExisted, installRecordExisted },
  };
  writeTransaction(transaction, layout);
  return transaction;
}

function assertSameTransaction(
  expected: CoreUpdateTransaction,
  current: CoreUpdateTransaction | undefined,
): asserts current is CoreUpdateTransaction {
  const sameRepair =
    expected.version === 1
      ? current?.version === 1
      : current?.version === 2 &&
        current.repair.binaryExisted === expected.repair.binaryExisted &&
        current.repair.installRecordExisted === expected.repair.installRecordExisted;
  if (
    !current ||
    current.version !== expected.version ||
    current.createdAt !== expected.createdAt ||
    current.targetRecord.coreVersion !== expected.targetRecord.coreVersion ||
    current.targetRecord.installedAt !== expected.targetRecord.installedAt ||
    !sameRepair
  ) {
    throw new Error("Core update transaction changed during publication");
  }
}

/** Move an inconsistent pair to fixed transaction-owned quarantine paths. */
export function quarantineCoreInstallationForUpdate(
  transaction: CoreRepairUpdateTransaction,
  layout: SashLayout,
): CoreRepairUpdateTransaction {
  const current = readCoreUpdateTransaction(layout);
  assertSameTransaction(transaction, current);
  if (current.version !== 2 || current.phase !== "repair-prepared") {
    throw new Error("Core repair transaction is not ready for quarantine");
  }

  if (current.repair.binaryExisted) {
    if (!pathEntryExists(layout.coreExe)) {
      throw new Error("Core repair executable disappeared before quarantine");
    }
    durableRenameSync(layout.coreExe, repairBinaryBackupPath(layout));
  } else if (pathEntryExists(layout.coreExe)) {
    throw new Error("Core executable appeared before repair quarantine");
  }

  if (current.repair.installRecordExisted) {
    if (!pathEntryExists(layout.installFile)) {
      throw new Error("Core install metadata disappeared before quarantine");
    }
    durableRenameSync(layout.installFile, repairInstallBackupPath(layout));
  } else if (pathEntryExists(layout.installFile)) {
    throw new Error("Core install metadata appeared before repair quarantine");
  }

  if (
    pathEntryExists(layout.coreExe) ||
    pathEntryExists(layout.installFile) ||
    pathEntryExists(repairBinaryBackupPath(layout)) !== current.repair.binaryExisted ||
    pathEntryExists(repairInstallBackupPath(layout)) !== current.repair.installRecordExisted
  ) {
    throw new Error("Core repair quarantine could not be verified");
  }

  const prepared: CoreRepairUpdateTransaction = { ...current, phase: "prepared" };
  writeTransaction(prepared, layout);
  return prepared;
}

export function markCoreUpdateSwapped<T extends CoreUpdateTransaction>(
  transaction: T,
  layout: SashLayout,
): T {
  const current = readCoreUpdateTransaction(layout);
  assertSameTransaction(transaction, current);
  if (current.phase !== "prepared") throw new Error("Core update is not ready to mark swapped");
  const swapped = { ...current, phase: "swapped" } as T;
  writeTransaction(swapped, layout);
  return swapped;
}

export function markCoreUpdateHealthVerified<T extends CoreUpdateTransaction>(
  transaction: T,
  layout: SashLayout,
): T {
  const current = readCoreUpdateTransaction(layout);
  assertSameTransaction(transaction, current);
  if (current.phase !== "swapped") {
    throw new Error("Core update is not ready to mark health-verified");
  }
  const verified = { ...current, phase: "health-verified" } as T;
  writeTransaction(verified, layout);
  return verified;
}

function markCoreRepairRestoring(
  transaction: CoreRepairUpdateTransaction,
  layout: SashLayout,
): CoreRepairUpdateTransaction {
  const current = readCoreUpdateTransaction(layout);
  assertSameTransaction(transaction, current);
  if (current.version !== 2) throw new Error("Core update is not a repair transaction");
  if (current.phase === "repair-restoring") return current;
  const restoring: CoreRepairUpdateTransaction = { ...current, phase: "repair-restoring" };
  writeTransaction(restoring, layout);
  return restoring;
}

export function clearCoreUpdateTransaction(layout: SashLayout): void {
  durableRemoveFileSync(layout.coreUpdateTransactionFile);
}

function restoreInstallRecord(record: InstallRecord | null, layout: SashLayout): void {
  if (record) writeInstallRecord(record, layout);
  else durableRemoveFileSync(layout.installFile);
}

function rollbackNormalCoreUpdate(
  transaction: NormalCoreUpdateTransaction,
  layout: SashLayout,
  verifier: CoreExecutableVerifier,
): InstallRecord | null {
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

function removeRepairCandidateBinary(
  transaction: CoreRepairUpdateTransaction,
  layout: SashLayout,
  verifier: CoreExecutableVerifier,
): void {
  if (!pathEntryExists(layout.coreExe)) return;
  verifyTransactionBinary(
    layout.coreExe,
    transaction.targetRecord.coreVersion,
    verifier,
    "Core repair candidate",
  );
  durableRemoveFileSync(layout.coreExe);
}

function verifyRepairCandidateRecord(
  transaction: CoreRepairUpdateTransaction,
  layout: SashLayout,
): void {
  const current = readInstallRecord(layout);
  if (!installRecordsEqual(current, transaction.targetRecord)) {
    throw new Error("Core repair candidate install metadata does not match its journal");
  }
}

function removeRepairCandidateRecord(
  transaction: CoreRepairUpdateTransaction,
  layout: SashLayout,
): void {
  if (!pathEntryExists(layout.installFile)) return;
  verifyRepairCandidateRecord(transaction, layout);
  durableRemoveFileSync(layout.installFile);
}

function assertRepairRollbackOwnership(
  transaction: CoreRepairUpdateTransaction,
  layout: SashLayout,
  verifier: CoreExecutableVerifier,
): void {
  if (pathEntryExists(backupPath(layout))) {
    throw new Error(`Core repair has an unexpected normal rollback slot: ${backupPath(layout)}`);
  }
  if (transaction.phase === "repair-restoring") return;

  const binaryCurrent = pathEntryExists(layout.coreExe);
  const binaryBackup = pathEntryExists(repairBinaryBackupPath(layout));
  if (transaction.repair.binaryExisted) {
    if (transaction.phase === "repair-prepared") {
      if (binaryCurrent === binaryBackup) {
        throw new Error("Core repair cannot identify the original executable during rollback");
      }
    } else if (!binaryBackup) {
      throw new Error("Core repair rollback lost the quarantined executable");
    }
  } else if (binaryBackup) {
    throw new Error(
      `Core repair has an unexpected executable backup: ${repairBinaryBackupPath(layout)}`,
    );
  }
  if (
    transaction.phase === "repair-prepared" &&
    !transaction.repair.binaryExisted &&
    binaryCurrent
  ) {
    throw new Error("Core executable appeared during repair preparation");
  }
  if (transaction.phase !== "repair-prepared" && binaryCurrent) {
    verifyTransactionBinary(
      layout.coreExe,
      transaction.targetRecord.coreVersion,
      verifier,
      "Core repair candidate",
    );
  }
  if (
    (transaction.phase === "swapped" || transaction.phase === "health-verified") &&
    !binaryCurrent
  ) {
    throw new Error("Core repair candidate disappeared before rollback");
  }

  const installCurrent = pathEntryExists(layout.installFile);
  const installBackup = pathEntryExists(repairInstallBackupPath(layout));
  if (transaction.repair.installRecordExisted) {
    if (transaction.phase === "repair-prepared") {
      if (installCurrent === installBackup) {
        throw new Error(
          "Core repair cannot identify the original install metadata during rollback",
        );
      }
    } else if (!installBackup) {
      throw new Error("Core repair rollback lost the quarantined install metadata");
    }
  } else if (installBackup) {
    throw new Error(
      `Core repair has an unexpected install metadata backup: ${repairInstallBackupPath(layout)}`,
    );
  }
  if (transaction.phase === "repair-prepared") {
    if (!transaction.repair.installRecordExisted && installCurrent) {
      throw new Error("Core install metadata appeared during repair preparation");
    }
    return;
  }
  if (transaction.phase === "prepared") {
    if (installCurrent) {
      throw new Error("Core install metadata appeared before the candidate swap was journaled");
    }
    return;
  }

  const shouldHaveTargetRecord =
    transaction.phase === "health-verified" || transaction.deferredHealth;
  if (shouldHaveTargetRecord !== installCurrent) {
    throw new Error("Core repair candidate install metadata does not match its journal phase");
  }
  if (installCurrent) verifyRepairCandidateRecord(transaction, layout);
}

function rollbackRepairCoreUpdate(
  transaction: CoreRepairUpdateTransaction,
  layout: SashLayout,
  verifier: CoreExecutableVerifier,
): null {
  assertRepairRollbackOwnership(transaction, layout, verifier);
  const restoring = markCoreRepairRestoring(transaction, layout);
  const binaryBackup = repairBinaryBackupPath(layout);
  const installBackup = repairInstallBackupPath(layout);

  if (restoring.repair.binaryExisted) {
    if (pathEntryExists(binaryBackup)) {
      removeRepairCandidateBinary(restoring, layout, verifier);
      durableRenameSync(binaryBackup, layout.coreExe);
    } else if (!pathEntryExists(layout.coreExe)) {
      throw new Error("Core repair rollback lost the quarantined executable");
    }
  } else {
    if (pathEntryExists(binaryBackup)) {
      throw new Error(`Core repair has an unexpected executable backup: ${binaryBackup}`);
    }
    removeRepairCandidateBinary(restoring, layout, verifier);
  }

  if (restoring.repair.installRecordExisted) {
    if (pathEntryExists(installBackup)) {
      removeRepairCandidateRecord(restoring, layout);
      durableRenameSync(installBackup, layout.installFile);
    } else if (!pathEntryExists(layout.installFile)) {
      throw new Error("Core repair rollback lost the quarantined install metadata");
    }
  } else {
    if (pathEntryExists(installBackup)) {
      throw new Error(`Core repair has an unexpected install metadata backup: ${installBackup}`);
    }
    removeRepairCandidateRecord(restoring, layout);
  }

  if (
    pathEntryExists(binaryBackup) ||
    pathEntryExists(installBackup) ||
    pathEntryExists(layout.coreExe) !== restoring.repair.binaryExisted ||
    pathEntryExists(layout.installFile) !== restoring.repair.installRecordExisted
  ) {
    throw new Error("Core repair rollback could not restore the exact prior entry presence");
  }
  clearCoreUpdateTransaction(layout);
  return null;
}

/** Restore exact pre-update state, preserving ambiguous files and failed journals. */
export function rollbackCoreUpdateTransaction(
  layout: SashLayout,
  verifier: CoreExecutableVerifier = defaultVerifier,
): InstallRecord | null | undefined {
  const transaction = readCoreUpdateTransaction(layout);
  if (!transaction) return undefined;
  return transaction.version === 1
    ? rollbackNormalCoreUpdate(transaction, layout, verifier)
    : rollbackRepairCoreUpdate(transaction, layout, verifier);
}

function assertRepairBackupEntry(file: string, role: string): void {
  if (!pathEntryExists(file)) return;
  if (fs.lstatSync(file).isDirectory()) {
    throw new Error(`Pending Core repair ${role} backup is a directory: ${file}`);
  }
}

function validatePendingRepairAssets(
  transaction: CoreRepairUpdateTransaction,
  layout: SashLayout,
): void {
  if (pathEntryExists(backupPath(layout))) {
    throw new Error(`Pending Core repair has an unexpected normal backup: ${backupPath(layout)}`);
  }
  const allowRemoved = transaction.phase === "health-verified";
  const binaryBackup = repairBinaryBackupPath(layout);
  const installBackup = repairInstallBackupPath(layout);
  assertRepairBackupEntry(binaryBackup, "executable");
  assertRepairBackupEntry(installBackup, "install metadata");

  if (transaction.repair.binaryExisted && !allowRemoved && !pathEntryExists(binaryBackup)) {
    throw new Error(`Pending Core repair is missing its executable backup: ${binaryBackup}`);
  }
  if (!transaction.repair.binaryExisted && pathEntryExists(binaryBackup)) {
    throw new Error(`Pending Core repair has an unexpected executable backup: ${binaryBackup}`);
  }
  if (transaction.repair.installRecordExisted && !allowRemoved && !pathEntryExists(installBackup)) {
    throw new Error(`Pending Core repair is missing its install metadata backup: ${installBackup}`);
  }
  if (!transaction.repair.installRecordExisted && pathEntryExists(installBackup)) {
    throw new Error(
      `Pending Core repair has an unexpected install metadata backup: ${installBackup}`,
    );
  }
}

function validatePendingTransaction(
  transaction: CoreUpdateTransaction,
  layout: SashLayout,
  verifier: CoreExecutableVerifier,
): void {
  if (transaction.phase !== "swapped" && transaction.phase !== "health-verified") {
    throw new Error("Core update is not pending a managed health decision");
  }
  verifyTransactionBinary(
    layout.coreExe,
    transaction.targetRecord.coreVersion,
    verifier,
    "Pending Core update candidate",
  );

  if (transaction.version === 1) {
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
  } else {
    validatePendingRepairAssets(transaction, layout);
  }

  const currentRecord = readInstallRecord(layout);
  if (!currentRecord && pathEntryExists(layout.installFile)) {
    throw new Error("Pending Core update install metadata is malformed or non-regular");
  }
  const recordMatchesPhase =
    transaction.version === 2
      ? transaction.phase === "health-verified" || transaction.deferredHealth
        ? installRecordsEqual(currentRecord, transaction.targetRecord)
        : currentRecord === undefined
      : transaction.phase === "health-verified"
        ? installRecordsEqual(currentRecord, transaction.targetRecord) ||
          installRecordsEqual(currentRecord, transaction.previousRecord)
        : installRecordsEqual(
            currentRecord,
            transaction.previousRecord ?? transaction.targetRecord,
          );
  if (!recordMatchesPhase) {
    throw new Error("Pending Core update install metadata does not match its journal phase");
  }
}

function rollbackRequired(transaction: CoreUpdateTransaction): boolean {
  return (
    transaction.phase === "repair-prepared" ||
    transaction.phase === "repair-restoring" ||
    transaction.phase === "prepared" ||
    (!transaction.deferredHealth && transaction.phase === "swapped")
  );
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
  if (rollbackRequired(transaction)) {
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
  return transaction?.phase === "swapped" || transaction?.phase === "health-verified"
    ? transaction.targetRecord.coreVersion
    : undefined;
}

function removeCommittedRollbackAssets(
  transaction: CoreUpdateTransaction,
  layout: SashLayout,
): void {
  if (transaction.version === 1) {
    durableRemoveFileSync(backupPath(layout));
    return;
  }
  durableRemoveFileSync(repairBinaryBackupPath(layout));
  durableRemoveFileSync(repairInstallBackupPath(layout));
}

function rollbackAssetsExist(transaction: CoreUpdateTransaction, layout: SashLayout): boolean {
  return transaction.version === 1
    ? pathEntryExists(backupPath(layout))
    : pathEntryExists(repairBinaryBackupPath(layout)) ||
        pathEntryExists(repairInstallBackupPath(layout));
}

/** Commit a successful managed start and consume its retained rollback slot. */
export function completePendingCoreUpdateAfterStart(
  layout: SashLayout,
  verifier: CoreExecutableVerifier = defaultVerifier,
): string | undefined {
  let transaction = readCoreUpdateTransaction(layout);
  if (!transaction) return undefined;
  if (transaction.phase !== "swapped" && transaction.phase !== "health-verified") {
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
  removeCommittedRollbackAssets(transaction, layout);
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
  removeCommittedRollbackAssets(transaction, layout);
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
  let transaction: CoreUpdateTransaction | undefined;
  let transactionStarted = false;
  let swapped = false;
  let runtimeStopped = false;

  try {
    if (readCoreUpdateTransaction(layout)) recoverCoreUpdateTransaction(layout, verifier);
    else recoverLegacyInterruptedCoreUpdate(layout, verifier, true);
    if (readCoreUpdateTransaction(layout)) {
      throw new Error(
        `A Core update is pending managed startup/finalization: ${layout.coreUpdateTransactionFile}`,
      );
    }

    let previousRecord = readInstallRecord(layout);
    const binaryExists = pathEntryExists(layout.coreExe);
    const installEntryExists = pathEntryExists(layout.installFile);
    const consistentEmpty = !binaryExists && !installEntryExists;
    const consistentInstalled =
      binaryExists && installEntryExists && isRegularFile(layout.coreExe) && previousRecord;
    const repairRequired = !consistentEmpty && !consistentInstalled;
    if (repairRequired && !opts.forceRepair) {
      throw new Error("Cannot update inconsistent Core binary/install metadata state");
    }

    const deferredHealth = runtime?.verifyRuntime !== true;
    if (repairRequired) {
      transaction = beginCoreRepairUpdateTransaction(layout, staged.version, deferredHealth);
      previousRecord = undefined;
    } else {
      transaction = beginCoreUpdateTransaction(
        layout,
        staged.version,
        previousRecord,
        deferredHealth,
      );
    }
    transactionStarted = true;

    if (runtime?.verifyRuntime) {
      await runtime.stop();
      runtimeStopped = true;
    }

    if (transaction.version === 2) {
      transaction = quarantineCoreInstallationForUpdate(transaction, layout);
    } else if (previousRecord) {
      await waitForBinaryUnlocked(layout.coreExe);
      durableRenameSync(layout.coreExe, backupPath(layout));
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
      backupRemoved: !rollbackAssetsExist(transaction, layout),
      pendingStartupValidation: deferredHealth,
    };
  } catch (err) {
    const rollbackErrors: string[] = [];
    let mayRestoreFiles = true;
    if (runtime?.verifyRuntime && swapped) {
      try {
        await runtime.stop();
        runtimeStopped = true;
      } catch (rollbackErr) {
        mayRestoreFiles = false;
        rollbackErrors.push((rollbackErr as Error).message);
      }
    }

    let restored: InstallRecord | null | undefined;
    if (mayRestoreFiles) {
      try {
        await opts.beforeRollback?.();
      } catch (rollbackErr) {
        rollbackErrors.push(`managed state: ${(rollbackErr as Error).message}`);
      }
      if (transactionStarted) {
        try {
          restored = rollbackCoreUpdateTransaction(layout, verifier);
        } catch (rollbackErr) {
          rollbackErrors.push(`Core binary: ${(rollbackErr as Error).message}`);
        }
      }
      if (runtime?.verifyRuntime && runtimeStopped && restored) {
        try {
          await runtime.startAndVerify(restored.coreVersion);
        } catch (rollbackErr) {
          rollbackErrors.push(`previous runtime: ${(rollbackErr as Error).message}`);
        }
      }
    }

    const message = (err as Error).message;
    if (rollbackErrors.length) {
      throw new Error(`${message}; rollback also failed: ${rollbackErrors.join("; ")}`);
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
  for (const repairBackup of [repairBinaryBackupPath(layout), repairInstallBackupPath(layout)]) {
    if (pathEntryExists(repairBackup)) {
      throw new Error(
        `Cannot recover Core repair backup without its transaction journal: ${repairBackup}`,
      );
    }
  }

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
