import fs from "node:fs";
import type { StagedCore } from "./core.js";
import { readInstallRecord, writeInstallRecord } from "./core.js";
import type { SashLayout } from "./paths.js";
import { waitForBinaryUnlocked } from "./process.js";

export interface CoreUpdateRuntime {
  /** Whether the core was running before the update began. */
  wasRunning: boolean;
  stop(): Promise<void>;
  /** Start the installed binary and resolve only after its health check passes. */
  startAndVerify(): Promise<void>;
}

export interface CoreUpdateResult {
  version: string;
  backupRemoved: boolean;
}

/**
 * Atomically replace the installed core and commit its install record only
 * after the staged binary (and, when applicable, the running controller) has
 * passed health checks. Binary and metadata are restored together on failure.
 */
export async function commitCoreUpdate(opts: {
  layout: SashLayout;
  staged: StagedCore;
  runtime?: CoreUpdateRuntime;
}): Promise<CoreUpdateResult> {
  const { layout, staged, runtime } = opts;
  const backup = `${layout.coreExe}.bak`;

  // Recover the fail-safe backup left by an interrupted earlier update.
  if (!fs.existsSync(layout.coreExe) && fs.existsSync(backup)) {
    fs.renameSync(backup, layout.coreExe);
  }

  const hadCurrent = fs.existsSync(layout.coreExe);
  const previousRecord = readInstallRecord(layout);
  let swapped = false;
  let runtimeStopped = false;
  let rollbackError: Error | undefined;

  try {
    if (fs.existsSync(backup)) {
      throw new Error(`Previous core backup still exists at ${backup}; resolve it before updating`);
    }

    if (runtime?.wasRunning) {
      await runtime.stop();
      runtimeStopped = true;
    }

    if (hadCurrent) {
      await waitForBinaryUnlocked(layout.coreExe);
      fs.renameSync(layout.coreExe, backup);
    }
    fs.renameSync(staged.exe, layout.coreExe);
    swapped = true;

    if (runtime?.wasRunning) {
      await runtime.startAndVerify();
    }

    writeInstallRecord(
      { coreVersion: staged.version, installedAt: new Date().toISOString() },
      layout,
    );
    fs.rmSync(backup, { force: true });
    return { version: staged.version, backupRemoved: true };
  } catch (err) {
    try {
      if (runtime?.wasRunning && swapped) {
        await runtime.stop().catch(() => undefined);
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
      if (runtime?.wasRunning && runtimeStopped && hadCurrent && fs.existsSync(layout.coreExe)) {
        await runtime.startAndVerify();
      }
    } catch (rollbackErr) {
      rollbackError = rollbackErr as Error;
    }

    const message = (err as Error).message;
    if (rollbackError) {
      throw new Error(`${message}; rollback also failed: ${rollbackError.message}`);
    }
    throw err;
  } finally {
    fs.rmSync(staged.exe, { force: true });
  }
}
