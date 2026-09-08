import crypto from "node:crypto";
import fs from "node:fs";

export const CORE_BINARY_SIZE_LIMIT = 512 * 1024 * 1024;

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Hash a bounded regular executable without allocating its entire contents. */
export function coreBinarySha256(file: string): string {
  if (!fs.lstatSync(file).isFile()) throw new Error(`Core binary must be a regular file: ${file}`);
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > CORE_BINARY_SIZE_LIMIT)
      throw new Error(`Core binary must be a nonempty regular file within 512MB: ${file}`);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      total += bytes;
      if (total > CORE_BINARY_SIZE_LIMIT)
        throw new Error(`Core binary exceeds the 512MB safety limit: ${file}`);
      hash.update(buffer.subarray(0, bytes));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

export function assertCoreBinaryDigest(file: string, expected: string | undefined): void {
  if (!isSha256(expected)) throw new Error(`Core integrity has not been verified: ${file}`);
  const actual = coreBinarySha256(file);
  if (actual !== expected) throw new Error(`Core SHA-256 mismatch; file preserved: ${file}`);
}
