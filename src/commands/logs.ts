import fs from "node:fs";
import { log } from "../log.js";
import { runtimeContext } from "./shared.js";

/** Print the last N lines of the core logs; with follow, keep streaming. */
export async function runLogs(
  opts: { lines?: number; follow?: boolean; errors?: boolean } = {},
): Promise<void> {
  const ctx = runtimeContext();
  const file = opts.errors ? ctx.layout.coreErrLogFile : ctx.layout.coreLogFile;
  if (!fs.existsSync(file)) {
    log.info(`no log file yet at ${file}`);
    return;
  }
  const lines = opts.lines ?? 50;
  printTail(file, lines);

  if (opts.follow) {
    let offset = fs.statSync(file).size;
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        try {
          const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
          if (size > offset) {
            const fd = fs.openSync(file, "r");
            const buf = Buffer.alloc(size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            fs.closeSync(fd);
            process.stdout.write(buf);
            offset = size;
          } else if (size < offset) {
            offset = 0; // log rotated/truncated
          }
        } catch {
          // transient read errors while the core writes; keep following
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
  const content = fs.readFileSync(file, "utf8");
  const all = content.split(/\r?\n/);
  const tail = all.slice(Math.max(0, all.length - lines - 1));
  process.stdout.write(tail.join("\n"));
  if (!content.endsWith("\n")) process.stdout.write("\n");
}
