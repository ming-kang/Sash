import fs from "node:fs";

/** Read one bounded regular file. */
export function readBoundedFile(file: string, maxBytes: number): Buffer {
  const bytes = fs.readFileSync(file);
  if (bytes.length > maxBytes) throw new Error(`File exceeds its read limit: ${file}`);
  return bytes;
}

export function readBoundedJsonFile(file: string, maxBytes: number): unknown {
  const bytes = readBoundedFile(file, maxBytes);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (cause) {
    throw new Error(`Invalid JSON file: ${file}`, { cause });
  }
}
