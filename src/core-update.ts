import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CoreUpdateResponse } from "./contracts.js";
import {
  assertCoreBinaryFile,
  currentCoreVersion,
  type InstallRecord,
  parseInstallRecord,
  readInstallRecord,
  resolveCoreRelease,
  type StagedCore,
  writeInstallRecord,
} from "./core.js";
import { errorMessage } from "./error-utils.js";
import {
  atomicWriteFileSync,
  durableRemoveFileSync,
  durableRenameSync,
  pathEntryExists,
} from "./fs-atomic.js";
import { parseSha256Digest, RELEASE_ASSET_SIZE_LIMIT, selectReleaseAsset } from "./github.js";
import type { ProxyFallbackListener } from "./http.js";
import { isPlainObject } from "./json-shape.js";
import type { SashLayout } from "./paths.js";
import type { SashDaemonClient } from "./sash-client-node.js";

export type CoreUpdateStage =
  | "checking"
  | "resolving"
  | "downloading"
  | "extracting"
  | "verifying"
  | "validating"
  | "waiting"
  | "installing";
export interface CoreUpdateProgress {
  stage: CoreUpdateStage;
  startedAt: string;
  target: string | null;
  downloading: boolean;
  downloaded: number;
  total: number | null;
  /** A non-fatal condition worth surfacing next to the stage, e.g. a proxy fallback. */
  note?: string;
}

/** The only upgrade journal: executable and install metadata, never profiles or settings. */
export interface CoreUpdateTransaction {
  previous: InstallRecord | null;
  target: InstallRecord;
  /** Set once the new binary passed its health check; cleanup may still be pending. */
  verified?: boolean;
}

export interface CoreUpdateRuntime {
  wasRunning: boolean;
  stop(): Promise<void>;
  startAndVerify(version: string): Promise<void>;
  applySystemProxy(): Promise<void>;
}

export interface CoreUpdateOptions {
  layout: SashLayout;
  staged: StagedCore;
  runtime: CoreUpdateRuntime;
}

export interface CoreUpdateResult {
  version: string;
}

export interface CoreUpdateCheck {
  current: string | null;
  target: string;
  available: boolean;
  asset: string;
}

/**
 * Lenient read: a damaged journal reads as absent, so it can never block daemon
 * startup; the `.bak` binary and the committed install record decide recovery.
 */
export function readCoreUpdateTransaction(layout: SashLayout): CoreUpdateTransaction | undefined {
  let text: string;
  try {
    text = fs.readFileSync(layout.coreUpdateTransactionFile, "utf8");
  } catch {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isPlainObject(value)) throw new Error("Not an object");
    const previous = value.previous === null ? null : parseInstallRecord(value.previous);
    const target = parseInstallRecord(value.target);
    if (previous === undefined || !target) throw new Error("Missing install records");
    return {
      previous,
      target,
      // Legacy journals recorded the phase as "verified" instead of a flag.
      ...(value.verified === true || value.phase === "verified" ? { verified: true } : {}),
    };
  } catch {
    return undefined;
  }
}

function writeCoreUpdateTransaction(layout: SashLayout, transaction: CoreUpdateTransaction): void {
  atomicWriteFileSync(
    layout.coreUpdateTransactionFile,
    `${JSON.stringify(transaction, null, 2)}\n`,
  );
}

function clearJournal(layout: SashLayout): void {
  durableRemoveFileSync(layout.coreUpdateTransactionFile);
}

/**
 * Roll a possibly-swapped installation back to its recorded previous state.
 * A missing backup only means the swap never began or had already been rolled
 * back, so the recorded previous state is written either way.
 */
function restoreTransaction(layout: SashLayout, transaction: CoreUpdateTransaction): void {
  const backup = `${layout.coreExe}.bak`;
  if (transaction.previous) {
    if (pathEntryExists(backup)) {
      if (pathEntryExists(layout.coreExe)) durableRemoveFileSync(layout.coreExe);
      durableRenameSync(backup, layout.coreExe);
    }
    writeInstallRecord(transaction.previous, layout);
  } else {
    if (pathEntryExists(backup)) throw new Error("Unexpected Core backup for a first install");
    if (pathEntryExists(layout.coreExe)) durableRemoveFileSync(layout.coreExe);
    if (pathEntryExists(layout.installFile)) {
      if (readInstallRecord(layout)?.coreVersion !== transaction.target.coreVersion)
        throw new Error("Unrecognized Core install metadata; preserved for inspection");
      durableRemoveFileSync(layout.installFile);
    }
  }
  clearJournal(layout);
}

/** The new binary passed its health check; only cleanup can still be pending. */
function finishVerified(layout: SashLayout, transaction: CoreUpdateTransaction): void {
  try {
    const backup = `${layout.coreExe}.bak`;
    if (pathEntryExists(backup)) {
      if (!transaction.previous) throw new Error("Unexpected backup for a first install");
      durableRemoveFileSync(backup);
    }
    clearJournal(layout);
  } catch (error) {
    console.warn(
      `[sashd] Core update succeeded; cleanup retained for retry: ${errorMessage(error)}`,
    );
  }
}

/** Called by the daemon after proxy recovery and verified orphan termination. */
export function recoverCoreUpdateTransaction(layout: SashLayout): void {
  const transaction = readCoreUpdateTransaction(layout);
  if (!transaction) {
    if (pathEntryExists(`${layout.coreExe}.bak`))
      throw new Error("Core backup has no ownership journal; preserved for inspection");
    return;
  }
  if (transaction.verified) finishVerified(layout, transaction);
  else restoreTransaction(layout, transaction);
}

export function binaryUnlockProbePath(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.unlock-probe`);
}

function regularFileStat(file: string): fs.BigIntStats | undefined {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error(`Binary path is not a regular file: ${file}`);
    return stat;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Restore a binary stranded by an interrupted Windows unlock probe. */
export function recoverBinaryUnlockProbe(target: string): void {
  const probe = binaryUnlockProbePath(target);
  const probeStat = regularFileStat(probe);
  if (!probeStat) return;
  const targetStat = regularFileStat(target);
  if (!targetStat) {
    durableRenameSync(probe, target);
    return;
  }
  if (
    probeStat.ino !== 0n &&
    probeStat.dev === targetStat.dev &&
    probeStat.ino === targetStat.ino
  ) {
    durableRemoveFileSync(probe);
    return;
  }
  throw new Error(
    `Core binary and unlock probe are separate files; preserved ${target} and ${probe}`,
  );
}

async function recoverUnlockProbeWithRetry(target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      recoverBinaryUnlockProbe(target);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < 3) await delay(100);
    }
  }
  throw lastError;
}

/**
 * Wait until a binary file is unlocked by Windows file handles/antivirus.
 * On POSIX platforms, returns immediately.
 */
export async function waitForBinaryUnlocked(target: string, timeoutMs = 30_000): Promise<void> {
  await recoverUnlockProbeWithRetry(target);
  if (process.platform !== "win32" || !fs.existsSync(target)) return;

  const probe = binaryUnlockProbePath(target);
  const deadline = Date.now() + timeoutMs;
  let waitMs = 150;

  while (Date.now() < deadline) {
    try {
      durableRenameSync(target, probe);
    } catch {
      await delay(waitMs);
      waitMs = Math.min(1000, Math.floor(waitMs * 1.5));
      continue;
    }

    try {
      durableRenameSync(probe, target);
      return;
    } catch (secondError) {
      try {
        await recoverUnlockProbeWithRetry(target);
        return;
      } catch (recoveryError) {
        throw new Error(
          `Failed to restore the binary after the lock probe; preserved state near ${probe}: ${(secondError as Error).message}; recovery failed: ${(recoveryError as Error).message}`,
        );
      }
    }
  }

  await recoverUnlockProbeWithRetry(target);
  throw new Error(
    `Binary is still locked after ${timeoutMs}ms: ${target}. Close programs using it and retry.`,
  );
}

/** Every install/update completes a real health check in this operation. */
export async function commitCoreUpdate(options: CoreUpdateOptions): Promise<CoreUpdateResult> {
  const { layout, staged, runtime } = options;
  if (readCoreUpdateTransaction(layout)) recoverCoreUpdateTransaction(layout);
  if (readCoreUpdateTransaction(layout) || pathEntryExists(`${layout.coreExe}.bak`)) {
    throw new Error("An unfinished Core update requires recovery before another update");
  }
  const previous = readInstallRecord(layout) ?? null;
  if (
    pathEntryExists(layout.coreExe) !== Boolean(previous) ||
    pathEntryExists(layout.installFile) !== Boolean(previous)
  ) {
    throw new Error(
      "Core installation is inconsistent; preserve its files and reinstall into a clean data directory",
    );
  }
  if (previous) assertCoreBinaryFile(layout.coreExe);
  assertCoreBinaryFile(staged.exe);
  fs.mkdirSync(layout.binDir, { recursive: true });
  await runtime.stop();
  const transaction: CoreUpdateTransaction = {
    previous,
    target: { coreVersion: staged.version },
  };
  try {
    writeCoreUpdateTransaction(layout, transaction);
    await waitForBinaryUnlocked(layout.coreExe);
    if (previous) durableRenameSync(layout.coreExe, `${layout.coreExe}.bak`);
    durableRenameSync(staged.exe, layout.coreExe);
    writeInstallRecord(transaction.target, layout);
    await runtime.startAndVerify(staged.version);
    if (runtime.wasRunning) await runtime.applySystemProxy();
    else await runtime.stop();
    writeCoreUpdateTransaction(layout, { ...transaction, verified: true });
    finishVerified(layout, transaction);
    return { version: staged.version };
  } catch (error) {
    try {
      // Never replace a binary while candidate termination is uncertain.
      await runtime.stop();
      restoreTransaction(layout, transaction);
      if (runtime.wasRunning && previous) {
        await runtime.startAndVerify(previous.coreVersion);
        await runtime.applySystemProxy();
      }
    } catch (rollback) {
      throw new Error(`${errorMessage(error)}; Core rollback failed: ${errorMessage(rollback)}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/** Read release metadata only; checking never starts management or downloads an archive. */
export async function checkCoreUpdate(
  layout: SashLayout,
  version?: string,
  signal?: AbortSignal,
  onProxyFallback?: ProxyFallbackListener,
): Promise<CoreUpdateCheck> {
  const current = currentCoreVersion(layout) || null;
  const { tag, assets, candidates } = await resolveCoreRelease({
    ...(version !== undefined ? { tag: version } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(onProxyFallback !== undefined ? { onProxyFallback } : {}),
  });
  const asset = selectReleaseAsset(assets, candidates);
  if (!asset)
    throw new Error(
      `No compatible Core artifact is available for ${process.platform}/${process.arch} at ${tag}`,
    );
  if (asset.size > RELEASE_ASSET_SIZE_LIMIT)
    throw new Error("Core release exceeds the download size limit");
  parseSha256Digest(asset.digest);
  return { current, target: tag, available: current !== tag, asset: asset.name };
}

const STAGE_TEXT: Record<CoreUpdateStage, string> = {
  checking: "Checking Core installation",
  resolving: "Checking the Core release",
  downloading: "Downloading Core",
  extracting: "Extracting Core",
  verifying: "Verifying the Core executable",
  validating: "Validating the runtime configuration",
  waiting: "Waiting for pending operations",
  installing: "Installing and verifying Core; restoring runtime state",
};

export function coreUpdateProgressText(progress: CoreUpdateProgress): string {
  const target = progress.target ? ` (${progress.target})` : "";
  const bytes = progress.downloading
    ? `: ${(progress.downloaded / 1048576).toFixed(1)}${progress.total ? ` / ${(progress.total / 1048576).toFixed(1)}` : ""} MiB`
    : "";
  const note = progress.note ? ` · ${progress.note}` : "";
  return `${STAGE_TEXT[progress.stage]}${target}${bytes}${note}`;
}

/**
 * Poll Core update progress while an operation runs. Supplemental progress
 * reads never retry or determine the outcome of the operation.
 */
export async function withCoreUpdateProgress<T>(
  client: Pick<SashDaemonClient, "coreUpdateProgress">,
  operation: Promise<T>,
  onProgress: (progress: CoreUpdateProgress) => void,
): Promise<T> {
  const controller = new AbortController();
  const watching = (async () => {
    while (!controller.signal.aborted) {
      try {
        await delay(500, undefined, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) return;
        throw error;
      }
      try {
        const progress = await client.coreUpdateProgress();
        if (!controller.signal.aborted && progress) onProgress(progress);
      } catch {
        // Progress errors do not affect the operation.
      }
    }
  })();
  try {
    return await operation;
  } finally {
    controller.abort();
    await watching;
  }
}

/** Supplemental progress reads never retry or determine the outcome of the mutation. */
export async function updateCoreWithProgress(
  client: Pick<SashDaemonClient, "updateCore" | "coreUpdateProgress">,
  version?: string,
  onProgress?: (progress: CoreUpdateProgress) => void,
): Promise<CoreUpdateResponse> {
  if (!onProgress) return client.updateCore(version);
  return withCoreUpdateProgress(client, client.updateCore(version), onProgress);
}
