import fs from "node:fs";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { hasExactOwnKeys, isCanonicalIsoTimestamp, isPlainObject } from "./json-shape.js";
import { type SashLayout, sashLayout } from "./paths.js";

const INSTALL_RECORD_SIZE_LIMIT = 16 * 1024;

export interface InstallRecord {
  coreVersion: string;
  installedAt: string;
}

export function validateCoreReleaseTag(tag: string): string {
  const normalized = tag.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error(`Invalid Core release tag: ${tag}`);
  }
  return normalized;
}

export function parseInstallRecord(value: unknown): InstallRecord | undefined {
  if (!isPlainObject(value) || !hasExactOwnKeys(value, ["coreVersion", "installedAt"])) {
    return undefined;
  }
  if (typeof value.coreVersion !== "string" || !isCanonicalIsoTimestamp(value.installedAt)) {
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

export function readInstallRecord(layout: SashLayout = sashLayout()): InstallRecord | undefined {
  try {
    const stat = fs.lstatSync(layout.installFile);
    if (!stat.isFile() || stat.size > INSTALL_RECORD_SIZE_LIMIT) return undefined;
    return parseInstallRecord(JSON.parse(fs.readFileSync(layout.installFile, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

export function writeInstallRecord(record: InstallRecord, layout: SashLayout = sashLayout()): void {
  const coreVersion = validateCoreReleaseTag(record.coreVersion);
  if (!isCanonicalIsoTimestamp(record.installedAt)) {
    throw new Error(`Invalid Core install timestamp: ${record.installedAt}`);
  }
  atomicWriteFileSync(
    layout.installFile,
    `${JSON.stringify({ coreVersion, installedAt: record.installedAt }, null, 2)}\n`,
  );
}

/** Best-effort current Core version, read from the committed install record. */
export function currentCoreVersion(layout: SashLayout = sashLayout()): string {
  return readInstallRecord(layout)?.coreVersion ?? "";
}

export function installRecordsEqual(
  left: InstallRecord | undefined,
  right: InstallRecord | null,
): boolean {
  if (!left || !right) return left === undefined && right === null;
  return left.coreVersion === right.coreVersion && left.installedAt === right.installedAt;
}
