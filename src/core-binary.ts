import fs from "node:fs";

export const CORE_BINARY_SIZE_LIMIT = 512 * 1024 * 1024;

/** Require a nonempty regular executable within the size limit. */
export function assertCoreBinaryFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > CORE_BINARY_SIZE_LIMIT)
    throw new Error(`Core binary must be a nonempty regular file within 512MB: ${file}`);
}
