import fs from "node:fs/promises";
import type { SashLayout } from "../paths.js";

export async function requireCoreFile(layout: SashLayout): Promise<void> {
  const stat = await fs.lstat(layout.coreExe).catch(() => undefined);
  if (!stat?.isFile())
    throw new Error(
      `Core is not installed at ${layout.coreExe}; run sash start or sash update first`,
    );
}

/** POSIX single-quoted shell literal. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
