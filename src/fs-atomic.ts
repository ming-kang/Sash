import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Atomic file writes: write to a temp file in the same directory, fsync, then
 * rename over the target. Retries rename on Windows to ride out transient
 * sharing violations from antivirus/indexers.
 */

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
  renameWithRetry(tmp, target);
  fsyncParentDirectory(dir);
}

/** Remove a file and durably persist its directory entry on POSIX. */
export function durableRemoveFileSync(target: string): void {
  try {
    fs.unlinkSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  fsyncParentDirectory(path.dirname(target));
}

function renameWithRetry(from: string, to: string): void {
  const delays = [0, 50, 100, 200, 400];
  let lastErr: unknown;
  for (const delay of delays) {
    if (delay > 0) sleepSync(delay);
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !code || !["EPERM", "EBUSY", "EACCES"].includes(code)) {
        break;
      }
    }
  }
  try {
    fs.rmSync(from, { force: true });
  } catch {
    // best effort
  }
  throw lastErr;
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
