import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { errnoCode } from "./error-utils.js";

/**
 * Atomic file writes: write to a temp file in the same directory, fsync, then
 * rename over the target. Windows sharing violations are retried without ever
 * deleting the caller-owned rename source.
 */

const WINDOWS_TRANSIENT_FILE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const DEFAULT_RETRY_DELAYS = [0, 50, 100, 200, 400] as const;

export interface FileRetryOptions {
  platform?: NodeJS.Platform;
  delays?: readonly number[];
  sleep?: (ms: number) => void;
  rename?: (from: string, to: string) => void;
  unlink?: (target: string) => void;
}

function shouldRetryFileError(error: unknown, platform: NodeJS.Platform): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return platform === "win32" && Boolean(code && WINDOWS_TRANSIENT_FILE_CODES.has(code));
}

/** Rename with bounded Windows retries. Failure always leaves source cleanup to the caller. */
export function renameWithRetrySync(
  from: string,
  to: string,
  options: FileRetryOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const delays = options.delays?.length ? options.delays : DEFAULT_RETRY_DELAYS;
  const sleep = options.sleep ?? sleepSync;
  const rename = options.rename ?? fs.renameSync;
  let lastError: unknown;
  for (const delay of delays) {
    if (delay > 0) sleep(delay);
    try {
      rename(from, to);
      return;
    } catch (err) {
      lastError = err;
      if (!shouldRetryFileError(err, platform)) break;
    }
  }
  throw lastError;
}

/** Remove with bounded Windows retries; returns false only when already absent. */
export function removeWithRetrySync(target: string, options: FileRetryOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  const delays = options.delays?.length ? options.delays : DEFAULT_RETRY_DELAYS;
  const sleep = options.sleep ?? sleepSync;
  const unlink = options.unlink ?? fs.unlinkSync;
  let lastError: unknown;
  for (const delay of delays) {
    if (delay > 0) sleep(delay);
    try {
      unlink(target);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      lastError = err;
      if (!shouldRetryFileError(err, platform)) break;
    }
  }
  throw lastError;
}

export function pathEntryExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return false;
    throw err;
  }
}

export function atomicWriteFileSync(target: string, data: string | Buffer, mode = 0o600): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (err) {
    try {
      fs.closeSync(fd);
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }
  fs.closeSync(fd);
  try {
    renameWithRetrySync(tmp, target);
  } catch (err) {
    // This temp file belongs to atomicWriteFileSync, unlike a caller-owned
    // durableRename source, so explicit local compensation is safe.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Preserve the publication error; a uniquely named temp may remain.
    }
    throw err;
  }
  fsyncParentDirectory(dir);
}

/** Remove a file and durably persist its directory entry on POSIX. */
export function durableRemoveFileSync(target: string): void {
  if (removeWithRetrySync(target)) fsyncParentDirectory(path.dirname(target));
}

/** Rename a file and durably persist both affected directory entries on POSIX. */
export function durableRenameSync(from: string, to: string): void {
  renameWithRetrySync(from, to);
  const sourceDir = path.dirname(from);
  const destinationDir = path.dirname(to);
  fsyncParentDirectory(destinationDir);
  if (sourceDir !== destinationDir) fsyncParentDirectory(sourceDir);
}

function fsyncParentDirectory(dir: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
