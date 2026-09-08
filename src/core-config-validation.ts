import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./fs-atomic.js";
import type { SashLayout } from "./paths.js";
import { buildSanitizedEnv } from "./process.js";

export type CoreConfigTestRunner = (
  executable: string,
  args: string[],
  signal?: AbortSignal,
) => Promise<void> | void;

function defaultRunner(executable: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: "utf8",
        env: buildSanitizedEnv(),
        maxBuffer: 1024 * 1024,
        timeout: 20_000,
        windowsHide: true,
        signal,
      },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve();
      },
    );
  });
}

function errorOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const record = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
  for (const value of [record.stderr, record.stdout, record.message]) {
    const text = Buffer.isBuffer(value)
      ? value.toString("utf8").trim()
      : String(value ?? "").trim();
    if (text) return text.slice(0, 1000);
  }
  return "unknown validation error";
}

/** Validate exact generated YAML without publishing it. Stop/shutdown cancels the owned child. */
export async function validateCoreConfig(
  executable: string,
  yaml: string,
  layout: SashLayout,
  options: { runner?: CoreConfigTestRunner; signal?: AbortSignal } = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  if (!fs.existsSync(executable)) throw new Error(`Core executable is missing: ${executable}`);
  const candidate = path.join(layout.tempDir, `config-validate-${crypto.randomUUID()}.yaml`);
  try {
    atomicWriteFileSync(candidate, yaml);
    await (options.runner ?? defaultRunner)(
      executable,
      ["-t", "-d", layout.root, "-f", candidate],
      options.signal,
    );
    options.signal?.throwIfAborted();
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new Error(`Core rejected generated configuration: ${errorOutput(error)}`, {
      cause: error,
    });
  } finally {
    fs.rmSync(candidate, { force: true });
  }
}
