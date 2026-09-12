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

/** Default budget for a configuration test; mirror retries raise it because a geodata download takes time. */
export const CONFIG_TEST_TIMEOUT_MS = 20_000;
export const CONFIG_TEST_GEODATA_TIMEOUT_MS = 180_000;

function defaultRunner(
  executable: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = CONFIG_TEST_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: "utf8",
        env: buildSanitizedEnv(),
        maxBuffer: 1024 * 1024,
        timeout: timeoutMs,
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
/** A database left by an interrupted download fails to parse on the next run. */
const GEODATA_CORRUPT =
  /(can't (open|read|load|parse)|invalid|corrupt)[^\n]*(MMDB|GeoIP|GeoSite|geodata)/i;

/**
 * Every database file the Core may fetch into the data root. Cleanup after a
 * failed download must never touch anything outside this list.
 */
export const GEODATA_FILE_NAMES = [
  "geoip.dat",
  "geoip.metadb",
  "geosite.dat",
  "country.mmdb",
  "GeoLite2-ASN.mmdb",
] as const;

/** mtime per known geodata file; null when absent or unreadable. */
type GeodataSnapshot = Map<string, number | null>;

function snapshotGeodataFiles(root: string): GeodataSnapshot {
  const snapshot: GeodataSnapshot = new Map();
  for (const name of GEODATA_FILE_NAMES) {
    let mtime: number | null = null;
    try {
      mtime = fs.statSync(path.join(root, name)).mtimeMs;
    } catch {
      // Absent or unreadable reads as absent.
    }
    snapshot.set(name, mtime);
  }
  return snapshot;
}

/**
 * Remove only what a failed attempt plausibly damaged: files created or
 * modified since the snapshot (download partials). When the Core refused to
 * parse a database, the error output names that file and it is removed too;
 * a file the Core never mentioned and never rewrote stays untouched.
 */
function removeDamagedGeodataFiles(
  root: string,
  snapshot: GeodataSnapshot,
  output: string,
  options: { includeMentioned: boolean },
): void {
  const mentioned = options.includeMentioned
    ? new Set(
        GEODATA_FILE_NAMES.filter((name) => output.toLowerCase().includes(name.toLowerCase())),
      )
    : new Set<string>();
  for (const name of GEODATA_FILE_NAMES) {
    const before = snapshot.get(name) ?? null;
    let current: fs.Stats;
    try {
      current = fs.statSync(path.join(root, name));
    } catch {
      continue;
    }
    const touched = before === null || current.mtimeMs !== before;
    if (!touched && !mentioned.has(name)) continue;
    try {
      fs.rmSync(path.join(root, name), { force: true });
      console.warn(`[sashd] removed damaged geodata file ${name}`);
    } catch {
      // A file that cannot be removed fails the next validation the same way.
    }
  }
}

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

function classifyGeodataFailure(error: unknown): "download" | "corrupt" | undefined {
  const text = errorOutput(error);
  if (GEODATA_DOWNLOAD.test(text)) return "download";
  if (GEODATA_CORRUPT.test(text)) return "corrupt";
  // A stalled download is killed by our own timeout and leaves only the
  // attempt line behind, so treat "we started a geodata download" as the signal.
  const killed = typeof error === "object" && error !== null && "killed" in error;
  return killed && GEODATA_ATTEMPT.test(text) ? "download" : undefined;
}

function looksLikeGeodataDownloadFailure(error: unknown): boolean {
  return classifyGeodataFailure(error) !== undefined;
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
  options: { runner?: CoreConfigTestRunner; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  if (!fs.existsSync(executable)) throw new Error(`Core executable is missing: ${executable}`);
  const candidate = path.join(layout.tempDir, `config-validate-${crypto.randomUUID()}.yaml`);
  const geodataSnapshot = snapshotGeodataFiles(layout.root);
  try {
    atomicWriteFileSync(candidate, yaml);
    await (
      options.runner ??
      ((exe: string, args: string[], sig?: AbortSignal) =>
        defaultRunner(exe, args, sig, options.timeoutMs))
    )(executable, ["-t", "-d", layout.root, "-f", candidate], options.signal);
    options.signal?.throwIfAborted();
  } catch (error) {
    options.signal?.throwIfAborted();
    const geodataFailure = classifyGeodataFailure(error);
    if (geodataFailure) {
      removeDamagedGeodataFiles(layout.root, geodataSnapshot, errorOutput(error), {
        includeMentioned: geodataFailure === "corrupt",
      });
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
