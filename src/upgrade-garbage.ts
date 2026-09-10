import fs from "node:fs";
import { readBoundedJsonFile } from "./bounded-file.js";
import { errnoCode } from "./error-utils.js";
import { durableRemoveFileSync, pathEntryExists } from "./fs-atomic.js";
import { canonicalPath, type NpmInstallation, pathsEqual } from "./installation.js";
import { hasExactOwnKeys, isPlainObject } from "./json-shape.js";
import { upgradePaths, upgradeTransactionPaths } from "./upgrade-paths.js";
import { observeUpgradeProcesses } from "./upgrade-processes.js";

interface CompletedArtifact {
  transactionId: string;
}

/** Read-only recognition of a cleanup interrupted after the installation journal was removed. */
export function completedUpgradeArtifacts(installation: NpmInstallation): CompletedArtifact[] {
  const directory = upgradePaths(installation.prefix).transactions;
  let entries: fs.Dirent[];
  try {
    if (!fs.lstatSync(directory).isDirectory() || !pathsEqual(canonicalPath(directory), directory))
      throw new Error("Sash recovery directory has an unexpected owner");
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
  if (entries.length > 1024) throw new Error("Too many Sash recovery directories");
  const found: CompletedArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
    const paths = upgradeTransactionPaths(installation.prefix, entry.name);
    let owner: unknown;
    try {
      owner = readBoundedJsonFile(paths.owner, 1024);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") continue;
      throw error;
    }
    if (
      isPlainObject(owner) &&
      (hasExactOwnKeys(owner, ["transactionId", "installationId", "complete"]) ||
        hasExactOwnKeys(owner, ["transactionId", "installationId", "workerSha256", "complete"])) &&
      owner.transactionId === entry.name &&
      owner.installationId === installation.id &&
      owner.complete === true
    )
      found.push({ transactionId: entry.name });
  }
  return found;
}

export async function cleanCompletedUpgradeArtifacts(
  installation: NpmInstallation,
): Promise<number> {
  const artifacts = completedUpgradeArtifacts(installation);
  if (!artifacts.length) return 0;
  const processes = await observeUpgradeProcesses();
  for (const artifact of artifacts) {
    const paths = upgradeTransactionPaths(installation.prefix, artifact.transactionId);
    if (!pathsEqual(canonicalPath(paths.root), paths.root))
      throw new Error("Sash recovery cleanup escaped its owned directory");
    const marker = paths.root.replaceAll("\\", "/").toLowerCase();
    if (
      processes.some(
        (row) =>
          row.pid !== process.pid &&
          row.pid !== process.ppid &&
          row.commandLine?.replaceAll("\\", "/").toLowerCase().includes(marker),
      )
    )
      throw new Error("A Sash recovery process is still using its files");
    if (
      fs.readdirSync(paths.root).some((entry) => entry !== "owner.json" && entry !== "worker.mjs")
    )
      throw new Error("Completed Sash recovery directory contains unrecognized files");
    if (pathEntryExists(paths.worker)) {
      if (!fs.lstatSync(paths.worker).isFile())
        throw new Error("Sash recovery worker is not a regular file");
      durableRemoveFileSync(paths.worker);
    }
    durableRemoveFileSync(paths.owner);
    fs.rmdirSync(paths.root);
  }
  return artifacts.length;
}
