import fs from "node:fs";
import { loadSettings } from "../app-state.js";
import type { CoreStartResult } from "../contracts.js";
import { errnoCode, errorMessage } from "../error-utils.js";
import { durableRenameSync } from "../fs-atomic.js";
import { type SashLayout, sashLayout } from "../paths.js";
import { withPrivateAppendLogFds } from "../process.js";
import { ensureRunning } from "../runtime-owner.js";

function recordStart(layout: SashLayout, message: string): void {
  try {
    fs.mkdirSync(layout.logsDir, { recursive: true, mode: 0o700 });
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(layout.sashLogFile);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
    if (stat && !stat.isFile()) throw new Error("Startup log is not a regular file");
    if (stat && stat.size >= 1024 * 1024) {
      durableRenameSync(layout.sashLogFile, `${layout.sashLogFile}.1`);
    }
    const line = `${new Date().toISOString()} ${message.replace(/[\r\n\t]+/g, " ").slice(0, 2000)}\n`;
    withPrivateAppendLogFds(layout.sashLogFile, layout.sashLogFile, ({ stdoutFd }) => {
      fs.writeSync(stdoutFd, line);
    });
  } catch (error) {
    // Logging must not replace the original startup failure.
    console.error(`[sash] Could not write startup log: ${errorMessage(error)}`);
  }
}

/** The same ownership/health flow as sash start, with diagnostics before settings are loaded. */
export async function startAtLogin(
  layout: SashLayout = sashLayout(),
  start: () => Promise<CoreStartResult> = async () => {
    const { result } = await ensureRunning({ layout, settings: loadSettings(layout) });
    return result;
  },
): Promise<CoreStartResult> {
  recordStart(layout, "login start requested");
  try {
    const result = await start();
    recordStart(layout, `login start ok pid=${result.pid}`);
    return result;
  } catch (error) {
    recordStart(layout, `login start failed: ${errorMessage(error)}`);
    throw error;
  }
}
