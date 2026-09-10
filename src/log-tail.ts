import fs from "node:fs";
import { errnoCode } from "./error-utils.js";

const TAIL_FILE_CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_LINE_BYTES = 64 * 1024;
export interface LogFileCursor {
  identity: string | null;
  offset: number;
}

export function fileIdentity(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

/** Tail text and follow position describe the same descriptor and captured end offset. */
export function readLogTail(
  file: string,
  lineCount: number,
): { text: string; cursor: LogFileCursor } {
  if (!Number.isSafeInteger(lineCount) || lineCount <= 0) throw new Error("Invalid log line count");
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0)
      throw new Error(`Log path is not safely readable: ${file}`);
    const cursor = { identity: fileIdentity(stat), offset: stat.size };
    let position = stat.size;
    let pending = "";
    const lines: string[] = [];
    while (position > 0 && lines.length < lineCount) {
      const bytesToRead = Math.min(TAIL_FILE_CHUNK_BYTES, position);
      position -= bytesToRead;
      const chunk = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = fs.readSync(fd, chunk, 0, bytesToRead, position);
      const parts = (chunk.subarray(0, bytesRead).toString("utf8") + pending).split(/\r?\n/);
      pending = parts.shift() ?? "";
      if (Buffer.byteLength(pending) > MAX_TAIL_LINE_BYTES)
        pending = pending.slice(-MAX_TAIL_LINE_BYTES);
      for (let i = parts.length - 1; i >= 0 && lines.length < lineCount; i--) {
        const line = parts[i];
        if (line?.trim()) lines.push(line);
      }
    }
    if (lines.length < lineCount && pending.trim()) lines.push(pending);
    return { text: lines.reverse().join("\n"), cursor };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { text: "", cursor: { identity: null, offset: 0 } };
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
