import { readBoundedJsonFile } from "./bounded-file.js";
import { errnoCode } from "./error-utils.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import {
  assertAbsolutePath,
  canonicalPath,
  installationIdFromCanonicalPath,
  type NpmInstallation,
  npmPackageRoot,
  npmShimPaths,
  pathsEqual,
} from "./installation.js";
import { type InstallationInstance, parseInstallationInstance } from "./installation-registry.js";
import { hasExactOwnKeys, isCanonicalIsoTimestamp, isPlainObject, isSha256 } from "./json-shape.js";
import { exactSashVersion, UPGRADE_PROTOCOL } from "./package-info.js";
import {
  type PackageIdentity,
  parsePackageIdentity,
  parseShimImage,
  type ShimImage,
} from "./upgrade-files.js";
import { upgradePaths } from "./upgrade-paths.js";

const UPGRADE_PHASES = [
  "preparing",
  "prepared",
  "reserving",
  "stopping",
  "activating",
  "restoring",
  "committed",
  "rolling-back",
  "rolled-back",
  "cancelled",
  "commit-cleanup",
  "rollback-cleanup",
  "cancel-cleanup",
] as const;
export type UpgradePhase = (typeof UPGRADE_PHASES)[number];
export interface UpgradeInstanceReference {
  source: InstallationInstance;
  restoreNodePath: string;
}
export interface UpgradeJournal {
  format: 2;
  protocol: typeof UPGRADE_PROTOCOL;
  transactionId: string;
  installation: NpmInstallation;
  sourceVersion: string;
  targetVersion: string;
  createdAt: string;
  phase: UpgradePhase;
  source: PackageIdentity;
  candidate: PackageIdentity | null;
  sourceShims: ShimImage[];
  candidateShims: ShimImage[] | null;
  recoveryShims: ShimImage[];
  instances: UpgradeInstanceReference[];
}

const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;

function parseInstallation(value: unknown, prefix: string): NpmInstallation {
  if (
    !isPlainObject(value) ||
    !hasExactOwnKeys(value, [
      "kind",
      "id",
      "packageRoot",
      "prefix",
      "binDir",
      "cliPath",
      "nodePath",
      "platform",
    ]) ||
    value.kind !== "npm-global" ||
    value.platform !== process.platform ||
    !isSha256(value.id)
  )
    throw new Error("Invalid upgrade installation layout");
  for (const key of ["packageRoot", "prefix", "binDir", "cliPath", "nodePath"] as const) {
    if (typeof value[key] !== "string") throw new Error("Invalid upgrade installation path");
    assertAbsolutePath(value[key]);
  }
  const installation = value as unknown as NpmInstallation;
  if (
    !pathsEqual(installation.prefix, prefix) ||
    !pathsEqual(installation.packageRoot, npmPackageRoot(prefix)) ||
    installation.id !== installationIdFromCanonicalPath(installation.packageRoot) ||
    !pathsEqual(installation.cliPath, `${installation.packageRoot}/dist/cli.js`) ||
    !pathsEqual(installation.binDir, process.platform === "win32" ? prefix : `${prefix}/bin`)
  )
    throw new Error("Sash upgrade paths differ from their fixed installation roles");
  return { ...installation };
}

function parseUpgradeJournal(value: unknown, prefix: string): UpgradeJournal {
  if (
    !isPlainObject(value) ||
    !hasExactOwnKeys(value, [
      "format",
      "protocol",
      "transactionId",
      "installation",
      "sourceVersion",
      "targetVersion",
      "createdAt",
      "phase",
      "source",
      "candidate",
      "sourceShims",
      "candidateShims",
      "recoveryShims",
      "instances",
    ]) ||
    value.format !== 2 ||
    value.protocol !== UPGRADE_PROTOCOL ||
    typeof value.transactionId !== "string" ||
    !/^[a-f0-9]{32}$/.test(value.transactionId) ||
    !isCanonicalIsoTimestamp(value.createdAt) ||
    !UPGRADE_PHASES.some((phase) => phase === value.phase) ||
    !Array.isArray(value.instances) ||
    value.instances.length > 1024
  )
    throw new Error("Invalid Sash installation upgrade journal");
  const installation = parseInstallation(value.installation, prefix);
  const images = (input: unknown): ShimImage[] => {
    if (!Array.isArray(input) || input.length !== npmShimPaths(prefix).length)
      throw new Error("Invalid Sash shim roles");
    return input.map(parseShimImage);
  };
  const sourceVersion = exactSashVersion(value.sourceVersion);
  const instances = value.instances.map((item: unknown): UpgradeInstanceReference => {
    if (
      !isPlainObject(item) ||
      !hasExactOwnKeys(item, ["source", "restoreNodePath"]) ||
      typeof item.restoreNodePath !== "string"
    )
      throw new Error("Invalid Sash upgrade instance reference");
    assertAbsolutePath(item.restoreNodePath);
    const source = parseInstallationInstance(item.source, installation.id);
    if (
      !pathsEqual(source.packageRoot, installation.packageRoot) ||
      source.sashVersion !== sourceVersion
    )
      throw new Error("Instance reference belongs to a different package version");
    return { source, restoreNodePath: item.restoreNodePath };
  });
  if (
    instances.some((item, i) =>
      instances
        .slice(0, i)
        .some((previous) => pathsEqual(item.source.dataDir, previous.source.dataDir)),
    )
  )
    throw new Error("Duplicate Sash instance in upgrade journal");
  const candidate = value.candidate === null ? null : parsePackageIdentity(value.candidate);
  const candidateShims = value.candidateShims === null ? null : images(value.candidateShims);
  if ((candidate === null) !== (candidateShims === null))
    throw new Error("Incomplete candidate package ownership");
  if (
    !["preparing", "cancelled", "cancel-cleanup"].includes(String(value.phase)) &&
    (!candidate || !candidateShims)
  )
    throw new Error("Sash upgrade phase requires a verified candidate");
  return {
    format: 2,
    protocol: UPGRADE_PROTOCOL,
    transactionId: value.transactionId,
    installation,
    sourceVersion,
    targetVersion: exactSashVersion(value.targetVersion),
    createdAt: value.createdAt,
    phase: value.phase as UpgradePhase,
    source: parsePackageIdentity(value.source),
    candidate,
    sourceShims: images(value.sourceShims),
    candidateShims,
    recoveryShims: images(value.recoveryShims),
    instances,
  };
}

function readJournalValue(prefix: string): unknown {
  try {
    return readBoundedJsonFile(upgradePaths(prefix).journal, MAX_JOURNAL_BYTES);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Older pending transactions run their original standalone worker, without migrating its journal. */
export function readPendingUpgrade(
  prefix: string,
):
  | Pick<
      UpgradeJournal,
      "transactionId" | "installation" | "sourceVersion" | "targetVersion" | "phase"
    >
  | undefined {
  const value = readJournalValue(prefix);
  if (value === undefined) return undefined;
  const canonicalPrefix = canonicalPath(prefix);
  if (isPlainObject(value) && value.format === 2)
    return parseUpgradeJournal(value, canonicalPrefix);
  if (
    !isPlainObject(value) ||
    value.format !== undefined ||
    value.protocol !== UPGRADE_PROTOCOL ||
    typeof value.transactionId !== "string" ||
    !/^[a-f0-9]{32}$/.test(value.transactionId) ||
    !UPGRADE_PHASES.some((phase) => phase === value.phase)
  )
    throw new Error("Invalid pending Sash upgrade");
  return {
    transactionId: value.transactionId,
    installation: parseInstallation(value.installation, canonicalPrefix),
    sourceVersion: exactSashVersion(value.sourceVersion),
    targetVersion: exactSashVersion(value.targetVersion),
    phase: value.phase as UpgradePhase,
  };
}

export function readUpgradeJournal(prefix: string): UpgradeJournal | undefined {
  const value = readJournalValue(prefix);
  if (value === undefined) return undefined;
  // Normalize caller aliases, while keeping every persisted installation role strictly checked.
  return parseUpgradeJournal(value, canonicalPath(prefix));
}

export function writeUpgradeJournal(journal: UpgradeJournal): void {
  const canonical = parseUpgradeJournal(journal, journal.installation.prefix);
  const text = `${JSON.stringify(canonical)}\n`;
  if (Buffer.byteLength(text) > MAX_JOURNAL_BYTES)
    throw new Error("Sash upgrade journal exceeds its size limit");
  atomicWriteFileSync(upgradePaths(journal.installation.prefix).journal, text, 0o600);
}

export function readUpgradeBarrier(
  prefix: string,
): { transactionId: string; installationId: string } | undefined {
  let value: unknown;
  try {
    value = readBoundedJsonFile(upgradePaths(prefix).barrier, 1024);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (
    !isPlainObject(value) ||
    !hasExactOwnKeys(value, ["transactionId", "installationId"]) ||
    typeof value.transactionId !== "string" ||
    !/^[a-f0-9]{32}$/.test(value.transactionId) ||
    !isSha256(value.installationId)
  )
    throw new Error("Invalid Sash upgrade startup barrier");
  return { transactionId: value.transactionId, installationId: value.installationId };
}

export function publishUpgradeBarrier(journal: UpgradeJournal): void {
  atomicWriteFileSync(
    upgradePaths(journal.installation.prefix).barrier,
    `${JSON.stringify({ transactionId: journal.transactionId, installationId: journal.installation.id })}\n`,
    0o644,
  );
}
