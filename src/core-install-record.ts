import fs from "node:fs";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { type SashLayout, sashLayout } from "./paths.js";

export interface InstallRecord {
  coreVersion: string;
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
  return { coreVersion: validateCoreReleaseTag(String(source?.coreVersion ?? "")) };
}

/** Lenient read used for private journals and for the committed installation record. */
export function parseInstallRecord(value: unknown): InstallRecord | undefined {
  const source = value as Record<string, unknown> | null;
  if (typeof source?.coreVersion !== "string") return undefined;
  try {
    return toInstallRecord(value);
  } catch {
    return undefined;
  }
}

/** Best-effort read; an unreadable record means "no Core installed". */
export function readInstallRecord(layout: SashLayout = sashLayout()): InstallRecord | undefined {
  try {
    return parseInstallRecord(JSON.parse(fs.readFileSync(layout.installFile, "utf8")) as unknown);
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
