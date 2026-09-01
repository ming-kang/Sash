import fs from "node:fs";
import type { StagedCore } from "./core.js";
import { readInstallRecord, verifyCoreExecutable, writeInstallRecord } from "./core.js";
import type { SashLayout } from "./paths.js";
import { waitForBinaryUnlocked } from "./process.js";

export interface CoreUpdateRuntime {
  /** Whether this transaction must launch and health-check the installed binary. */
  verifyRuntime: boolean;
  stop(): Promise<void>;
  /** Start the installed binary and verify the expected installed version. */
  startAndVerify(expectedVersion: string): Promise<void>;
}

export interface CoreUpdateResult {
  version: string;
  backupRemoved: boolean;
}

export interface CoreUpdateOptions {
  layout: SashLayout;
  staged: StagedCore;
  runtime?: CoreUpdateRuntime;
  verifyExecutable?: (exe: string, expectedVersion: string) => void;
  retainBackup?: boolean;
}

/**
 * Atomically replace the installed core and commit its install record only
 * after the staged binary (and, when applicable, the running controller) has
 * passed health checks. Binary and metadata are restored together on failure.
 */
export async function commitCoreUpdate(opts: CoreUpdateOptions): Promise<CoreUpdateResult> {
  try {
    return await commitCoreUpdateUnlocked(opts);
  } finally {
    fs.rmSync(opts.staged.exe, { force: true });
  }
}

type CoreExecutableVerifier = (exe: string, expectedVersion: string) => void;

export function recoverInterruptedCoreUpdate(
  layout: SashLayout,
  verifier: CoreExecutableVerifier = (exe, expectedVersion) =>
    verifyCoreExecutable(exe, 5000, expectedVersion),
  finalizeCommittedBackup = false,
): void {
  const backup = `${layout.coreExe}.bak`;
  if (!fs.existsSync(backup)) return;

  const previousRecord = readInstallRecord(layout);
  if (!previousRecord) {
    throw new Error(`Cannot recover ambiguous Core backup without install metadata: ${backup}`);
  }
  if (!fs.existsSync(layout.coreExe)) {
    try {
      verifier(backup, previousRecord.coreVersion);
    } catch {
      throw new Error(
        `Core backup does not match committed version ${previousRecord.coreVersion}: ${backup}`,
      );
    }
    fs.renameSync(backup, layout.coreExe);
    return;
  }

  let currentMatches = false;
  let backupMatches = false;
  try {
    verifier(layout.coreExe, previousRecord.coreVersion);
    currentMatches = true;
  } catch {
    // Try the rollback slot below.
  }
  if (!currentMatches) {
    try {
      verifier(backup, previousRecord.coreVersion);
      backupMatches = true;
    } catch {
      // Report the ambiguous state below.
    }
  }
  if (currentMatches) {
    if (finalizeCommittedBackup) fs.rmSync(backup);
  } else if (backupMatches) {
    fs.rmSync(layout.coreExe);
    fs.renameSync(backup, layout.coreExe);
  } else {
    throw new Error(
      `Cannot determine a safe Core after an interrupted update; preserved ${layout.coreExe} and ${backup}`,
    );
  }
}

export function finalizeCoreUpdateBackup(layout: SashLayout): void {
  recoverInterruptedCoreUpdate(layout, undefined, true);
}

async function commitCoreUpdateUnlocked(opts: CoreUpdateOptions): Promise<CoreUpdateResult> {
  const { layout, staged, runtime } = opts;
  const backup = `${layout.coreExe}.bak`;
  const previousRecord = readInstallRecord(layout);
  recoverInterruptedCoreUpdate(layout, opts.verifyExecutable, true);

  const hadCurrent = fs.existsSync(layout.coreExe);
  let swapped = false;
  let runtimeStopped = false;
  let rollbackError: Error | undefined;

  try {
    if (fs.existsSync(backup)) {
      throw new Error(`Previous core backup still exists at ${backup}; resolve it before updating`);
    }

    if (runtime?.verifyRuntime) {
      await runtime.stop();
      runtimeStopped = true;
    }

    if (hadCurrent) {
      await waitForBinaryUnlocked(layout.coreExe);
      fs.renameSync(layout.coreExe, backup);
    }
    fs.renameSync(staged.exe, layout.coreExe);
    swapped = true;

    if (runtime?.verifyRuntime) {
      await runtime.startAndVerify(staged.version);
    }

    writeInstallRecord(
      { coreVersion: staged.version, installedAt: new Date().toISOString() },
      layout,
    );
    if (!opts.retainBackup) fs.rmSync(backup, { force: true });
    return { version: staged.version, backupRemoved: !fs.existsSync(backup) };
  } catch (err) {
    try {
      if (runtime?.verifyRuntime && swapped) {
        await runtime.stop();
        runtimeStopped = true;
      }
      if (swapped && fs.existsSync(layout.coreExe)) {
        fs.rmSync(layout.coreExe, { force: true });
      }
      if (hadCurrent && fs.existsSync(backup)) {
        fs.renameSync(backup, layout.coreExe);
      }
      if (previousRecord) {
        writeInstallRecord(previousRecord, layout);
      } else {
        fs.rmSync(layout.installFile, { force: true });
      }
      if (runtime?.verifyRuntime && runtimeStopped && hadCurrent && fs.existsSync(layout.coreExe)) {
        if (!previousRecord) throw new Error("Cannot verify rolled-back Core without metadata");
        await runtime.startAndVerify(previousRecord.coreVersion);
      }
    } catch (rollbackErr) {
      rollbackError = rollbackErr as Error;
    }

    const message = (err as Error).message;
    if (rollbackError) {
      throw new Error(`${message}; rollback also failed: ${rollbackError.message}`);
    }
    throw err;
  }
}
