import fs from "node:fs";
import { errnoCode, errorMessage } from "../error-utils.js";
import { atomicWriteFileSync, durableRemoveFileSync } from "../fs-atomic.js";

/** Do not follow a replaced launcher or read an unbounded registration file. */
export function readRegistration(file: string): Buffer | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) {
      throw new Error(`Invalid autostart registration file: ${file}`);
    }
    const flags =
      fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW);
    const fd = fs.openSync(file, flags);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.size > 64 * 1024 || opened.ino !== stat.ino) {
        throw new Error(`Autostart registration changed while reading: ${file}`);
      }
      const data = Buffer.alloc(64 * 1024 + 1);
      const length = fs.readSync(fd, data, 0, data.length, 0);
      if (length > 64 * 1024) throw new Error(`Autostart registration is too large: ${file}`);
      return data.subarray(0, length);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Restore the previous launcher, including a stale one, if OS registration fails. */
export async function registerFile(
  file: string,
  contents: string | Buffer,
  register: () => Promise<void>,
  compensate?: () => Promise<void>,
): Promise<void> {
  const before = readRegistration(file);
  const next = Buffer.from(contents);
  atomicWriteFileSync(file, next);
  try {
    await register();
  } catch (error) {
    try {
      if (!readRegistration(file)?.equals(next)) {
        throw new Error("Autostart launcher changed during registration; preserved it");
      }
      if (before) atomicWriteFileSync(file, before);
      else durableRemoveFileSync(file);
      await compensate?.();
    } catch (rollbackError) {
      throw new Error(
        `${errorMessage(error)}; autostart rollback failed: ${errorMessage(rollbackError)}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export function removeRegistration(file: string): void {
  if (readRegistration(file) !== undefined) durableRemoveFileSync(file);
}
