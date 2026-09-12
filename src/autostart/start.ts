import fs from "node:fs";
import { loadSettings } from "../app-state.js";
import type { CoreStartResult } from "../contracts.js";
import { errnoCode, errorMessage } from "../error-utils.js";
import { durableRenameSync } from "../fs-atomic.js";
import { type SashLayout, sashLayout } from "../paths.js";
import { withPrivateAppendLogFds } from "../process.js";
import { ensureRunning } from "../runtime-owner.js";
import { writeLoginStartRecord } from "./login-record.js";

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

function recordOutcome(
  layout: SashLayout,
  record: { ok: boolean; attempts: number; error?: string },
): void {
  try {
    writeLoginStartRecord(layout, { at: new Date().toISOString(), ...record });
  } catch (error) {
    // The record feeds status and doctor; losing it must not mask startup itself.
    console.error(`[sash] Could not write the login start record: ${errorMessage(error)}`);
  }
}

/**
 * Backoff between login-start attempts: wireless and 802.1X networks often
 * come up seconds after sign-in, so the first attempt can be too early.
 */
export const LOGIN_START_RETRY_DELAYS_MS = [10_000, 20_000, 30_000] as const;

/** The same ownership/health flow as sash start, with diagnostics before settings are loaded. */
export async function startAtLogin(
  layout: SashLayout = sashLayout(),
  start: () => Promise<CoreStartResult> = async () => {
    const { result } = await ensureRunning({ layout, settings: loadSettings(layout) });
    return result;
  },
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<CoreStartResult> {
  recordStart(layout, "login start requested");
  let attempts = 0;
  let lastError: unknown;
  for (;;) {
    attempts += 1;
    try {
      const result = await start();
      recordStart(layout, `login start ok pid=${result.pid}`);
      recordOutcome(layout, { ok: true, attempts });
      return result;
    } catch (error) {
      lastError = error;
      const delay = LOGIN_START_RETRY_DELAYS_MS[attempts - 1];
      if (delay === undefined) break;
      recordStart(
        layout,
        `login start failed (${errorMessage(error)}); retrying in ${Math.round(delay / 1000)}s`,
      );
      await sleep(delay);
    }
  }
  recordStart(layout, `login start failed: ${errorMessage(lastError)}`);
  recordOutcome(layout, { ok: false, attempts, error: errorMessage(lastError) });
  throw lastError;
}
