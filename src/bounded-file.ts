import fs from "node:fs";

/** Read one bounded regular file through a single descriptor. */
export function readBoundedFile(file: string, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 16 * 1024 * 1024)
    throw new Error("Invalid bounded-file limit");
  if (!fs.lstatSync(file).isFile()) throw new Error(`File must be regular: ${file}`);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW),
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error(`File exceeds its read limit: ${file}`);
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes !== stat.size) throw new Error(`File changed during its read: ${file}`);
    return buffer.subarray(0, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

export function readBoundedJsonFile(file: string, maxBytes: number): unknown {
  const bytes = readBoundedFile(file, maxBytes);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (cause) {
    throw new Error(`Invalid JSON file: ${file}`, { cause });
  }
}
