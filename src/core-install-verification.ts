import fs from "node:fs";
import path from "node:path";
import { type StagedCore, stageCore } from "./core.js";
import {
  type InstallRecord,
  installRecordsEqual,
  readInstallRecord,
  writeInstallRecord,
} from "./core-install-record.js";
import { assertCoreBinaryDigest, isSha256 } from "./core-integrity.js";
import { readCoreUpdateTransaction, writeCoreUpdateTransaction } from "./core-update.js";
import type { SashLayout } from "./paths.js";

/** Verify existing version-only metadata against independently verified official release bytes. */
export async function ensureCoreIntegrityRecords(
  layout: SashLayout,
  stage: (version: string) => Promise<StagedCore> = (tag) => stageCore({ layout, tag, signal }),
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const installed = readInstallRecord(layout);
  const journal = readCoreUpdateTransaction(layout);
  const records = [installed, journal?.previous, journal?.target].filter(
    (record): record is InstallRecord => Boolean(record),
  );
  const missing = records.filter((record) => record.sha256 === undefined);
  if (missing.length === 0) return;
  const trusted = new Map<string, string>();
  for (const { coreVersion } of missing) {
    if (trusted.has(coreVersion)) continue;
    const candidate = await stage(coreVersion);
    try {
      signal?.throwIfAborted();
      if (candidate.version !== coreVersion || !isSha256(candidate.sha256))
        throw new Error("Official Core verification returned an unexpected release");
      assertCoreBinaryDigest(candidate.exe, candidate.sha256);
      trusted.set(coreVersion, candidate.sha256);
    } finally {
      fs.rmSync(candidate.exe, { force: true });
      try {
        fs.rmdirSync(path.dirname(candidate.exe));
      } catch {
        /* Remove only the now-empty staging directory. */
      }
    }
  }
  signal?.throwIfAborted();
  if (
    !installRecordsEqual(readInstallRecord(layout), installed ?? null) ||
    JSON.stringify(readCoreUpdateTransaction(layout)) !== JSON.stringify(journal)
  )
    throw new Error("Core install metadata changed during integrity verification; retry");

  const verified = (record: InstallRecord): InstallRecord => ({
    ...record,
    sha256: record.sha256 ?? trusted.get(record.coreVersion),
  });
  if (installed && !installed.sha256) {
    const next = verified(installed);
    // An interrupted swap's journal identifies the binary in each slot.
    if (!journal) assertCoreBinaryDigest(layout.coreExe, next.sha256);
    writeInstallRecord(next, layout);
  }
  if (journal && (!journal.target.sha256 || (journal.previous && !journal.previous.sha256))) {
    writeCoreUpdateTransaction(layout, {
      ...journal,
      target: verified(journal.target),
      previous: journal.previous ? verified(journal.previous) : null,
    });
  }
}
