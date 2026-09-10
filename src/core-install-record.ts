import { readBoundedJsonFile } from "./bounded-file.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { type SashLayout, sashLayout } from "./paths.js";

const INSTALL_RECORD_SIZE_LIMIT = 16 * 1024;

export interface InstallRecord {
  coreVersion: string;
  installedAt: string;
  /** The selected release asset; older installations did not record it. */
  assetName?: string;
}

export function validateCoreReleaseTag(tag: string): string {
  const normalized = tag.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error(`Invalid Core release tag: ${tag}`);
  }
  return normalized;
}

function toInstallRecord(value: unknown): InstallRecord {
  const source = value as Record<string, unknown>;
  return {
    coreVersion: validateCoreReleaseTag(String(source?.coreVersion ?? "")),
    installedAt: typeof source?.installedAt === "string" ? source.installedAt : "",
    ...(typeof source?.assetName === "string" ? { assetName: source.assetName } : {}),
  };
}

/** Lenient read used for private journals and for the committed installation record. */
export function parseInstallRecord(value: unknown): InstallRecord | undefined {
  const source = value as Record<string, unknown> | null;
  if (typeof source?.coreVersion !== "string" || typeof source.installedAt !== "string") {
    return undefined;
  }
  try {
    return toInstallRecord(value);
  } catch {
    return undefined;
  }
}

/** Best-effort read; an unreadable record means "no Core installed". */
export function readInstallRecord(layout: SashLayout = sashLayout()): InstallRecord | undefined {
  try {
    return parseInstallRecord(readBoundedJsonFile(layout.installFile, INSTALL_RECORD_SIZE_LIMIT));
  } catch {
    return undefined;
  }
}

export function writeInstallRecord(record: InstallRecord, layout: SashLayout = sashLayout()): void {
  const normalized = toInstallRecord(record);
  atomicWriteFileSync(layout.installFile, `${JSON.stringify(normalized, null, 2)}\n`);
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
  return (
    left.coreVersion === right.coreVersion &&
    left.installedAt === right.installedAt &&
    left.assetName === right.assetName
  );
}
