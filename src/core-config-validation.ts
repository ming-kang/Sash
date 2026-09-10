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

/**
 * The Core downloads its geodata databases while the configuration is loaded,
 * so a missing database on an unreachable network looks like a configuration
 * rejection. Recognize that case so the caller can retry through mirrors.
 */
const GEODATA_DOWNLOAD = /can't download (MMDB|GeoIP|GeoSite|ASN)/i;
const GEODATA_ATTEMPT = /(Can't find (MMDB|GeoIP|GeoSite)|start download)/i;

/**
 * The Core could not fetch the geodata its rules need, and did not report a
 * configuration problem. Distinct from a rejection so callers can retry through
 * the mirror list instead of telling the user their configuration is wrong.
 */
export class CoreGeodataUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CoreGeodataUnavailableError";
  }
}

function looksLikeGeodataDownloadFailure(error: unknown): boolean {
  const text = errorOutput(error);
  if (GEODATA_DOWNLOAD.test(text)) return true;
  // A stalled download is killed by our own timeout and leaves only the
  // attempt line behind, so treat "we started a geodata download" as the signal.
  const killed = typeof error === "object" && error !== null && "killed" in error;
  return killed && GEODATA_ATTEMPT.test(text);
}

/** True for both a raw Core failure and the error this module throws for it. */
export function isGeodataDownloadFailure(error: unknown): boolean {
  return error instanceof CoreGeodataUnavailableError || looksLikeGeodataDownloadFailure(error);
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
    if (looksLikeGeodataDownloadFailure(error)) {
      throw new CoreGeodataUnavailableError(
        `Core could not download its geodata databases: ${errorOutput(error)}. ` +
          `The Core fetches geodata itself and ignores HTTP_PROXY, so it needs a directly ` +
          `reachable source: place the files in ${layout.root} beforehand, or set geox-url to ` +
          `a reachable mirror in the profile.`,
        { cause: error },
      );
    }
    throw new Error(`Core rejected generated configuration: ${errorOutput(error)}`, {
      cause: error,
    });
  } finally {
    fs.rmSync(candidate, { force: true });
  }
}
