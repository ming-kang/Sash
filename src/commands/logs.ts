import { once } from "node:events";
import { cliOutputSignal } from "../cli-output.js";
import { log } from "../log.js";
import { followLogFile, normalizeLines } from "../log-follow.js";
import { readLogTail } from "../log-tail.js";
import { sashLayout } from "../paths.js";

/** Print the last N lines of logs; with follow, wait for and stream future files. */
export async function runLogs(
  opts: {
    lines?: number;
    follow?: boolean;
    errors?: boolean;
    daemon?: boolean;
    startup?: boolean;
  } = {},
): Promise<void> {
  if (opts.startup && (opts.daemon || opts.errors)) {
    throw new Error("--startup cannot be combined with --daemon or --errors");
  }
  // Diagnostics must remain readable even when corrupt settings prevented startup.
  const layout = sashLayout();
  let file: string;
  if (opts.startup) {
    file = layout.sashLogFile;
  } else if (opts.daemon) {
    file = opts.errors ? layout.daemonErrLogFile : layout.daemonLogFile;
  } else {
    file = opts.errors ? layout.coreErrLogFile : layout.coreLogFile;
  }

  const lines = normalizeLines(opts.lines);
  const { text, cursor } = readLogTail(file, lines);
  if (cursor.identity === null) {
    log.info(`${opts.follow ? "waiting for" : "no"} log file at ${file}`);
    if (!opts.follow) return;
  } else {
    if (text) process.stdout.write(`${text}\n`);
  }

  if (!opts.follow) return;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, cliOutputSignal]);
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await followLogFile(file, {
      cursor,
      signal,
      onChunk: async (chunk) => {
        if (process.stdout.write(chunk)) return;
        try {
          await once(process.stdout, "drain", { signal });
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      },
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
