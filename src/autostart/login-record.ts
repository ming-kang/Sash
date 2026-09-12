import fs from "node:fs";
import { atomicWriteFileSync } from "../fs-atomic.js";
import type { SashLayout } from "../paths.js";

/**
 * The last login-start outcome. The hidden launcher cannot show anything, so
 * this record is how `sash status` and `sash doctor` learn what happened.
 */
export interface LoginStartRecord {
  at: string;
  ok: boolean;
  attempts: number;
  error?: string;
}

export function writeLoginStartRecord(layout: SashLayout, record: LoginStartRecord): void {
  atomicWriteFileSync(layout.loginStartFile, `${JSON.stringify(record)}\n`);
}

/** Lenient by design: an unreadable or unknown record reads as absent. */
export function readLoginStartRecord(layout: SashLayout): LoginStartRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(layout.loginStartFile, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== "string" || typeof record.ok !== "boolean") return undefined;
  return {
    at: record.at,
    ok: record.ok,
    attempts:
      typeof record.attempts === "number" && Number.isSafeInteger(record.attempts)
        ? record.attempts
        : 1,
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}
