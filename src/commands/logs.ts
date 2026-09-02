import fs from "node:fs";
import { log } from "../log.js";
import { followLogFile, logCursorAtEnd, normalizeLines } from "../log-follow.js";
import { tailFile } from "../process.js";
import { runtimeContext } from "./shared.js";

/** Print the last N lines of logs; with follow, wait for and stream future files. */
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

  const lines = normalizeLines(opts.lines);
  const cursor = logCursorAtEnd(file);
  if (cursor.identity === null) {
    log.info(`${opts.follow ? "waiting for" : "no"} log file at ${file}`);
    if (!opts.follow) return;
  } else {
    printTail(file, lines);
  }

  if (!opts.follow) return;
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await followLogFile(file, {
      cursor,
      signal: controller.signal,
      onChunk: async (chunk) => {
        if (process.stdout.write(chunk)) return;
        await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
      },
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function printTail(file: string, lines: number): void {
  if (!fs.existsSync(file)) return;
  const tail = tailFile(file, lines);
  if (!tail) return;
  process.stdout.write(`${tail}\n`);
}
