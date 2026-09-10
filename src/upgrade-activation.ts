import fs from "node:fs";
import path from "node:path";
import { readBoundedJsonFile } from "./bounded-file.js";
import {
  atomicWriteFileSync,
  durableRemoveFileSync,
  durableRenameSync,
  pathEntryExists,
} from "./fs-atomic.js";
import { canonicalPath, npmPackageRoot, pathsEqual } from "./installation.js";
import { installationRegistryPaths } from "./installation-registry.js";
import { hasExactOwnKeys, isPlainObject } from "./json-shape.js";
import { readUpgradeAuthorization } from "./upgrade-access.js";
import {
  assertPackageIdentity,
  isInsideDirectory,
  type PackageIdentity,
  packageIdentitiesEqual,
  readPackageIdentity,
  removePackageSlot,
} from "./upgrade-files.js";
import { readUpgradeBarrier, type UpgradeJournal } from "./upgrade-journal.js";
import { activateUpgradeShims, publishRecoveryLauncher } from "./upgrade-launcher.js";
import { upgradePaths, upgradeTransactionPaths } from "./upgrade-paths.js";
import { observeUpgradeProcesses } from "./upgrade-processes.js";

export type UpgradeBoundary = (name: string) => void | Promise<void>;

function ownedSlot(slot: string, expected: PackageIdentity): boolean {
  if (!pathEntryExists(slot)) return false;
  assertPackageIdentity(slot, expected);
  return true;
}

export async function activateUpgradePackage(
  journal: UpgradeJournal,
  boundary: UpgradeBoundary,
): Promise<void> {
  const { installation, candidate } = journal;
  if (!candidate) throw new Error("Cannot activate an unverified Sash package");
  const paths = upgradeTransactionPaths(installation.prefix, journal.transactionId);
  const staged = npmPackageRoot(paths.stage);
  assertPackageIdentity(installation.packageRoot, journal.source);
  assertPackageIdentity(staged, candidate);
  if (pathEntryExists(paths.previous) || pathEntryExists(paths.rejected))
    throw new Error("Sash rollback slots are already occupied");
  publishRecoveryLauncher(journal);
  await boundary("launcher-published");
  activateUpgradeShims(journal, "recovery");
  await boundary("recovery-shims-published");
  durableRenameSync(installation.packageRoot, paths.previous);
  await boundary("previous-package-moved");
  if (pathEntryExists(installation.packageRoot))
    throw new Error("Sash package path was claimed during activation");
  durableRenameSync(staged, installation.packageRoot);
  await boundary("candidate-package-activated");
  // npm's hidden lockfile is only a cache. A fresh directory mtime invalidates stale entries.
  fs.utimesSync(installation.packageRoot, new Date(), new Date());
}

export async function restorePreviousPackage(
  journal: UpgradeJournal,
  boundary: UpgradeBoundary,
): Promise<void> {
  const { installation } = journal;
  const paths = upgradeTransactionPaths(installation.prefix, journal.transactionId);
  const active = pathEntryExists(installation.packageRoot)
    ? readPackageIdentity(installation.packageRoot)
    : undefined;
  if (packageIdentitiesEqual(active, journal.source)) return;
  if (!ownedSlot(paths.previous, journal.source))
    throw new Error("The previous Sash package is missing; recovery files preserved");
  if (active) {
    if (!journal.candidate || !packageIdentitiesEqual(active, journal.candidate))
      throw new Error("Active Sash package ownership is unknown; recovery files preserved");
    if (pathEntryExists(paths.rejected)) throw new Error("Sash rejected-package slot is occupied");
  }
  publishRecoveryLauncher(journal);
  activateUpgradeShims(journal, "recovery");
  await boundary("rollback-recovery-shims");
  if (active) {
    durableRenameSync(installation.packageRoot, paths.rejected);
    await boundary("rejected-package-moved");
  }
  if (pathEntryExists(installation.packageRoot))
    throw new Error("Sash package path was claimed during rollback");
  durableRenameSync(paths.previous, installation.packageRoot);
  await boundary("previous-package-restored");
  fs.utimesSync(installation.packageRoot, new Date(), new Date());
}

function assertTransactionOwner(journal: UpgradeJournal): string {
  const paths = upgradeTransactionPaths(journal.installation.prefix, journal.transactionId);
  const directory = canonicalPath(paths.root);
  if (
    !fs.lstatSync(paths.root).isDirectory() ||
    !pathsEqual(directory, paths.root) ||
    !isInsideDirectory(
      canonicalPath(upgradePaths(journal.installation.prefix).transactions),
      directory,
    )
  )
    throw new Error("Sash transaction directory has an unexpected owner");
  const owner = readBoundedJsonFile(paths.owner, 1024);
  if (
    !isPlainObject(owner) ||
    !hasExactOwnKeys(owner, ["transactionId", "installationId", "complete"]) ||
    owner.transactionId !== journal.transactionId ||
    owner.installationId !== journal.installation.id ||
    typeof owner.complete !== "boolean"
  )
    throw new Error("Sash transaction directory ownership marker changed");
  return directory;
}

/** The caller has made a durable cleanup decision and all daemon handoffs are already settled. */
export async function cleanUpgradeInstallation(
  journal: UpgradeJournal,
  boundary: UpgradeBoundary,
): Promise<string | undefined> {
  const paths = upgradeTransactionPaths(journal.installation.prefix, journal.transactionId);
  const global = upgradePaths(journal.installation.prefix);
  const committed = journal.phase === "commit-cleanup";
  const cancelled = journal.phase === "cancel-cleanup";
  const expected = committed ? journal.candidate : journal.source;
  if (!expected) throw new Error("Final Sash package ownership is missing");
  if (!cancelled) {
    assertPackageIdentity(journal.installation.packageRoot, expected);
    activateUpgradeShims(journal, committed ? "candidate" : "source");
  }
  const directory = assertTransactionOwner(journal);
  const barrier = readUpgradeBarrier(journal.installation.prefix);
  if (barrier) {
    if (
      barrier.transactionId !== journal.transactionId ||
      barrier.installationId !== journal.installation.id
    )
      throw new Error("Sash startup barrier changed during cleanup");
    durableRemoveFileSync(global.barrier);
  }
  const authorization = readUpgradeAuthorization(journal.installation.id);
  if (authorization) {
    if (authorization.transactionId !== journal.transactionId)
      throw new Error("Sash upgrade authority changed during cleanup");
    durableRemoveFileSync(installationRegistryPaths(journal.installation.id).upgradeAuthFile);
  }
  await boundary("startup-admission-released");
  const retained = (error: unknown): string =>
    `Installation settled; temporary files retained at ${directory}: ${error instanceof Error ? error.message : String(error)}`;
  try {
    const marker = paths.root.replaceAll("\\", "/").toLowerCase();
    const busy = (await observeUpgradeProcesses()).filter(
      (processInfo) =>
        processInfo.pid !== process.pid &&
        processInfo.pid !== process.ppid &&
        processInfo.commandLine?.replaceAll("\\", "/").toLowerCase().includes(marker),
    );
    if (busy.length)
      throw new Error(
        `Sash preparation processes are still using recovery files: PID ${busy.map((row) => row.pid).join(", ")}`,
      );
    for (const [slot, identity] of [
      [paths.previous, journal.source],
      [paths.rejected, journal.candidate],
      [npmPackageRoot(paths.stage), journal.candidate],
    ] as const) {
      if (!pathEntryExists(slot)) continue;
      if (identity) await removePackageSlot(slot, identity, directory);
      else if (slot !== npmPackageRoot(paths.stage))
        throw new Error("Unrecognized Sash package slot during cleanup");
    }
  } catch (error) {
    return retained(error);
  }
  await boundary("package-backups-cleaned");
  try {
    const allowed = new Set([
      "stage",
      "npm-cache",
      "npmrc",
      "global-npmrc",
      "candidate.tgz",
      "validation-data",
      "owner.json",
      "worker.mjs",
    ]);
    for (const entry of fs.readdirSync(directory)) {
      if (!allowed.has(entry))
        throw new Error(`Unrecognized file in Sash transaction directory: ${entry}`);
      if (entry === "owner.json" || entry === "worker.mjs") continue;
      const target = path.join(directory, entry);
      if (fs.lstatSync(target).isSymbolicLink()) {
        durableRemoveFileSync(target);
        continue;
      }
      const resolved = canonicalPath(target);
      if (!isInsideDirectory(directory, resolved))
        throw new Error("Sash cleanup escaped its transaction directory");
      // These are exclusively npm preparation roles in the private, nonce-owned directory.
      await fs.promises.rm(resolved, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
    atomicWriteFileSync(
      paths.owner,
      `${JSON.stringify({ transactionId: journal.transactionId, installationId: journal.installation.id, complete: true })}\n`,
    );
  } catch (error) {
    return retained(error);
  }
  await boundary("preparation-cleaned");
  try {
    durableRemoveFileSync(global.journal);
  } catch (error) {
    return retained(error);
  }
  await boundary("upgrade-journal-cleared");
  // Keep the small standalone launcher for an already-running shim; it forwards to the verified CLI when no journal exists.
  try {
    if (pathEntryExists(paths.worker)) durableRemoveFileSync(paths.worker);
    durableRemoveFileSync(paths.owner);
    fs.rmdirSync(directory);
  } catch (error) {
    return retained(error);
  }
}
