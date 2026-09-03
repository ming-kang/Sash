import fs from "node:fs";
import { atomicWriteFileSync, durableRemoveFileSync, pathEntryExists } from "./fs-atomic.js";
import { hasExactOwnKeys, isCanonicalIsoTimestamp, isPlainObject } from "./json-shape.js";
import type { SashLayout } from "./paths.js";

const TRANSACTION_VERSION = 1;
const TRANSACTION_SIZE_LIMIT = 16 * 1024;

export type CoreInstallTransactionPhase = "publishing" | "committed";

export interface CoreInstallTransaction {
  version: 1;
  phase: CoreInstallTransactionPhase;
  createdAt: string;
  targetVersion: string;
  binaryExisted: false;
  installRecordExisted: false;
}

function isCanonicalReleaseTag(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function parseTransaction(value: unknown): CoreInstallTransaction | undefined {
  if (!isPlainObject(value)) return undefined;
  if (
    !hasExactOwnKeys(value, [
      "binaryExisted",
      "createdAt",
      "installRecordExisted",
      "phase",
      "targetVersion",
      "version",
    ]) ||
    value.version !== TRANSACTION_VERSION ||
    (value.phase !== "publishing" && value.phase !== "committed") ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    !isCanonicalReleaseTag(value.targetVersion) ||
    value.binaryExisted !== false ||
    value.installRecordExisted !== false
  ) {
    return undefined;
  }
  return {
    version: 1,
    phase: value.phase,
    createdAt: value.createdAt,
    targetVersion: value.targetVersion,
    binaryExisted: false,
    installRecordExisted: false,
  };
}

function readTransaction(layout: SashLayout): CoreInstallTransaction | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(layout.coreInstallTransactionFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Cannot inspect Core install transaction ${layout.coreInstallTransactionFile}: ${(err as Error).message}`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(
      `Core install transaction is not a regular file: ${layout.coreInstallTransactionFile}`,
    );
  }
  if (stat.size > TRANSACTION_SIZE_LIMIT) {
    throw new Error(
      `Core install transaction exceeds ${TRANSACTION_SIZE_LIMIT} bytes: ${layout.coreInstallTransactionFile}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(layout.coreInstallTransactionFile, "utf8")) as unknown;
  } catch (err) {
    throw new Error(
      `Core install transaction is not valid JSON: ${layout.coreInstallTransactionFile} (${(err as Error).message})`,
    );
  }
  const transaction = parseTransaction(parsed);
  if (!transaction) {
    throw new Error(
      `Core install transaction has an invalid version, phase, timestamp, tag, or shape: ${layout.coreInstallTransactionFile}`,
    );
  }
  return transaction;
}

function writeTransaction(transaction: CoreInstallTransaction, layout: SashLayout): void {
  atomicWriteFileSync(
    layout.coreInstallTransactionFile,
    `${JSON.stringify(transaction, null, 2)}\n`,
  );
}

/**
 * Start the first-install publication transaction. First install has an empty
 * pre-install snapshot; ambiguous pre-existing binary or metadata is rejected.
 */
export function beginCoreInstallTransaction(
  targetVersion: string,
  layout: SashLayout,
  createdAt = new Date().toISOString(),
): CoreInstallTransaction {
  if (!isCanonicalReleaseTag(targetVersion)) {
    throw new Error(`Invalid Core release tag: ${targetVersion}`);
  }
  if (!isCanonicalIsoTimestamp(createdAt)) {
    throw new Error(`Invalid Core install timestamp: ${createdAt}`);
  }
  if (readTransaction(layout)) {
    throw new Error(
      `A Core install transaction is already pending: ${layout.coreInstallTransactionFile}`,
    );
  }
  if (pathEntryExists(layout.coreExe) || pathEntryExists(layout.installFile)) {
    throw new Error("Cannot begin a first-install transaction over existing Core state");
  }

  const transaction: CoreInstallTransaction = {
    version: 1,
    phase: "publishing",
    createdAt,
    targetVersion,
    binaryExisted: false,
    installRecordExisted: false,
  };
  writeTransaction(transaction, layout);
  return transaction;
}

export function markCoreInstallTransactionCommitted(
  transaction: CoreInstallTransaction,
  layout: SashLayout,
): void {
  const current = readTransaction(layout);
  if (
    current?.phase !== "publishing" ||
    current.createdAt !== transaction.createdAt ||
    current.targetVersion !== transaction.targetVersion
  ) {
    throw new Error("Core install transaction changed before commit");
  }
  writeTransaction({ ...current, phase: "committed" }, layout);
}

export function clearCoreInstallTransaction(layout: SashLayout): void {
  durableRemoveFileSync(layout.coreInstallTransactionFile);
}

/** Roll back publishing state, but never roll back a durably committed install. */
export function recoverCoreInstallTransaction(layout: SashLayout): void {
  const transaction = readTransaction(layout);
  if (!transaction) return;
  if (transaction.phase === "publishing") {
    durableRemoveFileSync(layout.coreExe);
    durableRemoveFileSync(layout.installFile);
  }
  clearCoreInstallTransaction(layout);
}
