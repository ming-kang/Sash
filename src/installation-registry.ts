import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBoundedJsonFile } from "./bounded-file.js";
import { errnoCode } from "./error-utils.js";
import { atomicWriteFileSync, durableRemoveFileSync } from "./fs-atomic.js";
import { assertAbsolutePath, canonicalPath, installationId, pathsEqual } from "./installation.js";
import { hasExactOwnKeys, isCanonicalIsoTimestamp, isPlainObject } from "./json-shape.js";
import { exactSashVersion } from "./package-info.js";

export interface InstallationInstance {
  schemaVersion: 1;
  installationId: string;
  packageRoot: string;
  dataDir: string;
  nodePath: string;
  sashVersion: string;
  pid: number;
  bootId: string;
  port: number;
  startedAt: string;
}

export function installationRegistryPaths(id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid installation identity");
  let base: string;
  if (process.platform === "win32") {
    const configured = process.env.LOCALAPPDATA;
    base = path.join(
      configured && path.isAbsolute(configured)
        ? configured
        : path.join(os.homedir(), "AppData", "Local"),
      "Sash",
    );
  } else {
    const configured = process.env.XDG_STATE_HOME;
    base =
      configured && path.isAbsolute(configured)
        ? path.join(configured, "sash")
        : process.platform === "darwin"
          ? path.join(os.homedir(), "Library", "Application Support", "Sash")
          : path.join(os.homedir(), ".local", "state", "sash");
  }
  const root = path.join(base, "installations", id);
  return {
    root,
    instancesDir: path.join(root, "instances"),
    startupLock: path.join(root, "startup.lock"),
    upgradeAuthFile: path.join(root, "upgrade-auth.json"),
  };
}

function instanceKey(dataDir: string): string {
  assertAbsolutePath(dataDir);
  const normalized = path.resolve(dataDir);
  return crypto.hash(
    "sha256",
    process.platform === "win32" ? normalized.toLowerCase() : normalized,
  );
}

function recordPath(record: Pick<InstallationInstance, "installationId" | "dataDir">): string {
  return path.join(
    installationRegistryPaths(record.installationId).instancesDir,
    `${instanceKey(record.dataDir)}.json`,
  );
}

function parseInstance(value: unknown, id: string): InstallationInstance {
  if (
    !isPlainObject(value) ||
    !hasExactOwnKeys(value, [
      "schemaVersion",
      "installationId",
      "packageRoot",
      "dataDir",
      "nodePath",
      "sashVersion",
      "pid",
      "bootId",
      "port",
      "startedAt",
    ]) ||
    value.schemaVersion !== 1 ||
    value.installationId !== id
  )
    throw new Error("Invalid installation instance record");
  const { packageRoot, dataDir, nodePath } = value;
  if (
    typeof packageRoot !== "string" ||
    typeof dataDir !== "string" ||
    typeof nodePath !== "string"
  )
    throw new Error("Invalid instance path");
  for (const name of [packageRoot, dataDir, nodePath]) assertAbsolutePath(name);
  if (
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.bootId !== "string" ||
    !/^[a-f0-9]{48}$/.test(value.bootId) ||
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    !isCanonicalIsoTimestamp(value.startedAt)
  )
    throw new Error("Invalid instance process identity");
  return {
    schemaVersion: 1,
    installationId: id,
    packageRoot,
    dataDir,
    nodePath,
    sashVersion: exactSashVersion(value.sashVersion),
    pid: value.pid,
    bootId: value.bootId,
    port: value.port,
    startedAt: value.startedAt,
  };
}

/** Called by the daemon holding the data-directory lease and installation startup gate. */
export function registerInstallationInstance(record: InstallationInstance): InstallationInstance {
  const normalized = parseInstance(
    {
      ...record,
      packageRoot: canonicalPath(record.packageRoot),
      dataDir: canonicalPath(record.dataDir),
      nodePath: canonicalPath(record.nodePath),
    },
    record.installationId,
  );
  if (installationId(normalized.packageRoot) !== normalized.installationId)
    throw new Error("Instance installation identity does not match its package root");
  atomicWriteFileSync(recordPath(normalized), `${JSON.stringify(normalized)}\n`);
  return normalized;
}

export function unregisterInstallationInstance(record: InstallationInstance): void {
  const file = recordPath(record);
  try {
    const current = parseInstance(readBoundedJsonFile(file, 16 * 1024), record.installationId);
    if (current.pid === record.pid && current.bootId === record.bootId) durableRemoveFileSync(file);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}

/** Unknown records must not be silently discarded when an upgrade discovers runtimes. */
export function listInstallationInstances(id: string, packageRoot: string): InstallationInstance[] {
  const directory = installationRegistryPaths(id).instancesDir;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
  if (entries.length > 1024) throw new Error("Too many installation instance records");
  return entries.map((entry) => {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name))
      throw new Error("Unrecognized installation registry entry");
    const file = path.join(directory, entry.name);
    const record = parseInstance(readBoundedJsonFile(file, 16 * 1024), id);
    if (
      !pathsEqual(record.packageRoot, packageRoot) ||
      path.basename(recordPath(record)) !== entry.name
    )
      throw new Error("Installation instance record has a mismatched owner");
    return record;
  });
}
