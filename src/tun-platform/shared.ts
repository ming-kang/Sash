import fs from "node:fs/promises";
import type { SashLayout } from "../paths.js";

export async function requireCoreFile(layout: SashLayout): Promise<void> {
  const stat = await fs.lstat(layout.coreExe).catch(() => undefined);
  if (!stat?.isFile())
    throw new Error(
      `Core is not installed at ${layout.coreExe}; run sash start or sash update first`,
    );
}

/**
 * Administrator prompts must never open from a test run: a queued dialog
 * would block forever, and approving it would change the real machine.
 */
export function refuseElevationInTests(action: string): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test")
    throw new Error(`Administrator approval to ${action} is unavailable inside tests`);
}

/** POSIX single-quoted shell literal. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
