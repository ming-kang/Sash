import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readBoundedFile, readBoundedJsonFile } from "./bounded-file.js";
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
  assertTreeFingerprint,
  fingerprintTree,
  isInsideDirectory,
  removePackageSlot,
  type TreeFingerprint,
} from "./upgrade-files.js";
import { readUpgradeBarrier, type UpgradeJournal } from "./upgrade-journal.js";
import { activateUpgradeShims, publishRecoveryLauncher } from "./upgrade-launcher.js";
import { upgradePaths, upgradeTransactionPaths } from "./upgrade-paths.js";
import { observeUpgradeProcesses } from "./upgrade-processes.js";

export type UpgradeBoundary = (name: string) => void | Promise<void>;

function ownedSlot(slot: string, expected: TreeFingerprint): boolean {
  if (!pathEntryExists(slot)) return false;
  assertTreeFingerprint(slot, expected);
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
  assertTreeFingerprint(installation.packageRoot, journal.source);
  assertTreeFingerprint(staged, candidate);
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
    ? fingerprintTree(installation.packageRoot)
    : undefined;
  if (active?.sha256 === journal.source.sha256) {
    assertTreeFingerprint(installation.packageRoot, journal.source);
    return;
  }
  if (!ownedSlot(paths.previous, journal.source))
    throw new Error("The previous Sash package is missing; recovery files preserved");
  if (active) {
    if (!journal.candidate || active.sha256 !== journal.candidate.sha256)
      throw new Error("Active Sash package ownership is unknown; recovery files preserved");
    assertTreeFingerprint(installation.packageRoot, journal.candidate);
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
    !hasExactOwnKeys(owner, ["transactionId", "installationId", "workerSha256", "complete"]) ||
    owner.transactionId !== journal.transactionId ||
    owner.installationId !== journal.installation.id ||
    owner.workerSha256 !== journal.workerSha256 ||
    typeof owner.complete !== "boolean"
  )
    throw new Error("Sash transaction directory ownership marker changed");
  return directory;
}

/** The caller has made a durable cleanup decision and all daemon handoffs are already settled. */
export async function cleanUpgradeInstallation(
  journal: UpgradeJournal,
  boundary: UpgradeBoundary,
): Promise<void> {
  const paths = upgradeTransactionPaths(journal.installation.prefix, journal.transactionId);
  const global = upgradePaths(journal.installation.prefix);
  const committed = journal.phase === "commit-cleanup";
  const cancelled = journal.phase === "cancel-cleanup";
  const expected = committed ? journal.candidate : journal.source;
  if (!expected) throw new Error("Final Sash package ownership is missing");
  if (!cancelled) {
    assertTreeFingerprint(journal.installation.packageRoot, expected);
    activateUpgradeShims(journal, committed ? "candidate" : "source");
  }
  const directory = assertTransactionOwner(journal);
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
  for (const [slot, fingerprint] of [
    [paths.previous, journal.source],
    [paths.rejected, journal.candidate],
    [npmPackageRoot(paths.stage), journal.candidate],
  ] as const) {
    if (!pathEntryExists(slot)) continue;
    if (fingerprint) removePackageSlot(slot, fingerprint, directory);
    else if (slot !== npmPackageRoot(paths.stage))
      throw new Error("Unrecognized Sash package slot during cleanup");
  }
  await boundary("package-backups-cleaned");
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
    `${JSON.stringify({ transactionId: journal.transactionId, installationId: journal.installation.id, workerSha256: journal.workerSha256, complete: true })}\n`,
  );
  await boundary("preparation-cleaned");
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
  if (
    pathEntryExists(paths.worker) &&
    crypto.hash("sha256", readBoundedFile(paths.worker, 16 * 1024 * 1024)) !== journal.workerSha256
  )
    throw new Error("Sash recovery worker changed during cleanup");
  durableRemoveFileSync(global.journal);
  await boundary("upgrade-journal-cleared");
  // Keep the small standalone launcher for an already-running shim; it forwards to the verified CLI when no journal exists.
  if (pathEntryExists(paths.worker)) {
    durableRemoveFileSync(paths.worker);
  }
  durableRemoveFileSync(paths.owner);
  fs.rmdirSync(directory);
}
