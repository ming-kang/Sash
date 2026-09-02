import fs from "node:fs";
import path from "node:path";

export const LOG_FOLLOW_CHUNK_BYTES = 64 * 1024;

export interface LogFileCursor {
  identity: string | null;
  offset: number;
}

export interface LogGrowth {
  chunks: Buffer[];
  cursor: LogFileCursor;
  hasMore: boolean;
  missing: boolean;
}

export interface FollowLogOptions {
  cursor?: LogFileCursor;
  chunkBytes?: number;
  pollMs?: number;
  signal: AbortSignal;
  onChunk: (chunk: Buffer) => void | Promise<void>;
}

export function normalizeLines(input: unknown, fallback = 50): number {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0 ? input : fallback;
}

export function parseLogLineCount(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("must be a positive integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("must be a positive safe integer");
  return parsed;
}

function fileIdentity(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function validateChunkBytes(chunkBytes: number): void {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error("chunkBytes must be a positive safe integer");
  }
}

function missingGrowth(): LogGrowth {
  return {
    chunks: [],
    cursor: { identity: null, offset: 0 },
    hasMore: false,
    missing: true,
  };
}

export function logCursorAtEnd(file: string): LogFileCursor {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Log path is not a regular file: ${file}`);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw new Error(`Log file size is not safely readable: ${file}`);
    }
    return { identity: fileIdentity(stat), offset: stat.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { identity: null, offset: 0 };
    }
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Read at most one bounded chunk, resetting the cursor on replacement or truncation. */
export function readLogGrowth(
  file: string,
  cursor: LogFileCursor,
  chunkBytes = LOG_FOLLOW_CHUNK_BYTES,
): LogGrowth {
  validateChunkBytes(chunkBytes);
  const safeOffset = Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 ? cursor.offset : 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Log path is not a regular file: ${file}`);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw new Error(`Log file size is not safely readable: ${file}`);
    }
    const identity = fileIdentity(stat);
    const position = cursor.identity === identity && stat.size >= safeOffset ? safeOffset : 0;
    if (position >= stat.size) {
      return {
        chunks: [],
        cursor: { identity, offset: position },
        hasMore: false,
        missing: false,
      };
    }

    const length = Math.min(chunkBytes, stat.size - position);
    const chunk = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, chunk, 0, length, position);
    const nextOffset = position + Math.max(0, bytesRead);
    return {
      chunks: bytesRead > 0 ? [chunk.subarray(0, bytesRead)] : [],
      cursor: { identity, offset: nextOffset },
      hasMore: nextOffset < stat.size,
      missing: false,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return missingGrowth();
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Follow a path like `tail -F`: wait for creation, detect replacement by file
 * identity, restart at byte zero after truncation, and retain a polling fallback
 * when directory watch events are unavailable or coalesced.
 */
export function followLogFile(file: string, options: FollowLogOptions): Promise<void> {
  const chunkBytes = options.chunkBytes ?? LOG_FOLLOW_CHUNK_BYTES;
  const pollMs = options.pollMs ?? 500;
  validateChunkBytes(chunkBytes);
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0) {
    throw new Error("pollMs must be a positive safe integer");
  }

  return new Promise<void>((resolve, reject) => {
    let cursor = options.cursor ?? { identity: null, offset: 0 };
    let watcher: fs.FSWatcher | undefined;
    let timer: NodeJS.Timeout | undefined;
    let draining = false;
    let queued = false;
    let stopped = false;

    const closeWatcher = (): void => {
      try {
        watcher?.close();
      } catch {
        // Already closed by the platform.
      }
      watcher = undefined;
    };

    const cleanup = (): void => {
      if (timer) clearInterval(timer);
      timer = undefined;
      closeWatcher();
      options.signal.removeEventListener("abort", onAbort);
    };

    const finish = (err?: unknown): void => {
      if (stopped) return;
      stopped = true;
      cleanup();
      if (err === undefined) resolve();
      else reject(err);
    };

    const installWatcher = (): void => {
      if (watcher || stopped) return;
      try {
        const watched = fs.watch(path.dirname(file), (_event, filename) => {
          if (filename === null || filename.toString() === path.basename(file)) scheduleDrain();
        });
        watched.on("error", () => {
          if (watcher === watched) watcher = undefined;
          try {
            watched.close();
          } catch {
            // Already closed by the platform.
          }
        });
        watched.on("close", () => {
          if (watcher === watched) watcher = undefined;
        });
        watcher = watched;
      } catch {
        // The directory may not exist yet. The polling fallback retries.
      }
    };

    const drain = async (): Promise<void> => {
      if (stopped || draining) {
        queued = !stopped;
        return;
      }
      draining = true;
      try {
        let chunksThisTurn = 0;
        do {
          queued = false;
          let growth: LogGrowth;
          try {
            growth = readLogGrowth(file, cursor, chunkBytes);
          } catch {
            // Sharing violations and rotation races are transient for follow mode.
            break;
          }
          cursor = growth.cursor;
          if (stopped) break;
          for (const chunk of growth.chunks) {
            await options.onChunk(chunk);
            if (stopped) break;
          }
          queued = !stopped && (queued || growth.hasMore);
          chunksThisTurn += growth.chunks.length;
          if (queued && chunksThisTurn >= 16) break;
        } while (queued && !stopped);
      } catch (err) {
        finish(err);
      } finally {
        draining = false;
        if (queued && !stopped) setImmediate(scheduleDrain);
      }
    };

    const scheduleDrain = (): void => {
      if (stopped) return;
      if (draining) {
        queued = true;
        return;
      }
      void drain();
    };

    const onAbort = (): void => finish();

    if (options.signal.aborted) {
      finish();
      return;
    }
    options.signal.addEventListener("abort", onAbort, { once: true });
    installWatcher();
    timer = setInterval(() => {
      installWatcher();
      scheduleDrain();
    }, pollMs);
    scheduleDrain();
  });
}
