import fs from "node:fs";
import { log } from "../log.js";
import { tailFile } from "../process.js";
import { runtimeContext } from "./shared.js";

export const LOG_FOLLOW_CHUNK_BYTES = 64 * 1024;

export function normalizeLines(input: unknown, fallback = 50): number {
  return typeof input === "number" && Number.isInteger(input) && input > 0 ? input : fallback;
}

/** Read appended log data in bounded chunks, resetting after truncation/rotation. */
export function readLogGrowth(
  file: string,
  offset: number,
  chunkBytes = LOG_FOLLOW_CHUNK_BYTES,
): { chunks: Buffer[]; offset: number } {
  if (!Number.isSafeInteger(offset) || offset < 0) offset = 0;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error("chunkBytes must be a positive safe integer");
  }
  const size = fs.statSync(file).size;
  let position = Math.min(offset, size);
  if (size < offset) position = 0;
  if (position >= size) return { chunks: [], offset: position };
  const length = Math.min(chunkBytes, size - position);
  const chunk = Buffer.allocUnsafe(length);
  const fd = fs.openSync(file, "r");
  try {
    const bytesRead = fs.readSync(fd, chunk, 0, length, position);
    if (bytesRead <= 0) return { chunks: [], offset: position };
    return { chunks: [chunk.subarray(0, bytesRead)], offset: position + bytesRead };
  } finally {
    fs.closeSync(fd);
  }
}

/** Print the last N lines of logs; with follow, keep streaming. */
export async function runLogs(
  opts: { lines?: number; follow?: boolean; errors?: boolean; daemon?: boolean } = {},
): Promise<void> {
  const ctx = runtimeContext();
  let file: string;
  if (opts.daemon) {
    file = opts.errors ? ctx.layout.daemonErrLogFile : ctx.layout.daemonLogFile;
  } else {
    file = opts.errors ? ctx.layout.coreErrLogFile : ctx.layout.coreLogFile;
  }

  if (!fs.existsSync(file)) {
    log.info(`no log file yet at ${file}`);
    return;
  }
  const lines = normalizeLines(opts.lines);
  printTail(file, lines);

  if (opts.follow) {
    let offset = fs.statSync(file).size;
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        try {
          if (!fs.existsSync(file)) {
            offset = 0;
            return;
          }
          const growth = readLogGrowth(file, offset);
          for (const chunk of growth.chunks) process.stdout.write(chunk);
          offset = growth.offset;
        } catch {
          // transient read errors while writing; keep following
        }
      }, 500);
      process.on("SIGINT", () => {
        clearInterval(timer);
        resolve();
      });
    });
  }
}

function printTail(file: string, lines: number): void {
  const tail = tailFile(file, lines);
  if (!tail) return;
  process.stdout.write(`${tail}\n`);
}
