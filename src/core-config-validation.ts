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

/** Default budget for a configuration test; a geodata download needs the longer CONFIG_TEST_GEODATA_TIMEOUT_MS. */
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

/** The Core fetches its geodata databases while the configuration loads; a missing database looks like a configuration rejection. */
const GEODATA_DOWNLOAD = /can't download (MMDB|GeoIP|GeoSite|ASN)/i;
const GEODATA_ATTEMPT = /(Can't find (MMDB|GeoIP|GeoSite)|start download)/i;
/** A database left by an interrupted download fails to parse on the next run. */
const GEODATA_CORRUPT =
  /(can't (open|read|load|parse)|invalid|corrupt)[^\n]*(MMDB|GeoIP|GeoSite|geodata)/i;

/** Every database file the Core may fetch into the data root; cleanup must never touch anything outside this list. */
export const GEODATA_FILE_NAMES = [
  "geoip.dat",
  "geoip.metadb",
  "geosite.dat",
  "country.mmdb",
  "GeoLite2-ASN.mmdb",
] as const;

type GeodataSnapshot = Map<string, number | null>;

function snapshotGeodataFiles(root: string): GeodataSnapshot {
  const snapshot: GeodataSnapshot = new Map();
  for (const name of GEODATA_FILE_NAMES) {
    let mtime: number | null = null;
    try {
      mtime = fs.statSync(path.join(root, name)).mtimeMs;
    } catch {}
    snapshot.set(name, mtime);
  }
  return snapshot;
}

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
    } catch {}
  }
}

/** The Core could not fetch its geodata and did not report a configuration problem; distinct from a rejection so callers retry through mirrors. */
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
  // Our own timeout kills a stalled download, leaving only the attempt line behind.
  const killed = typeof error === "object" && error !== null && "killed" in error;
  return killed && GEODATA_ATTEMPT.test(text) ? "download" : undefined;
}

function looksLikeGeodataDownloadFailure(error: unknown): boolean {
  return classifyGeodataFailure(error) !== undefined;
}

export function isGeodataDownloadFailure(error: unknown): boolean {
  return error instanceof CoreGeodataUnavailableError || looksLikeGeodataDownloadFailure(error);
}

const GEODATA_CLASS_FILES: Record<string, string> = {
  mmdb: "country.mmdb",
  geoip: "geoip.dat",
  geosite: "geosite.dat",
  asn: "GeoLite2-ASN.mmdb",
};

/** A mentioned known file name wins over the failure class, so non-default geox-url layouts still map. */
export function geodataFileForFailure(error: unknown): string | undefined {
  if (!isGeodataDownloadFailure(error)) return undefined;
  const output = errorOutput(error);
  const lower = output.toLowerCase();
  for (const name of GEODATA_FILE_NAMES) {
    if (lower.includes(name.toLowerCase())) return name;
  }
  const kind = GEODATA_DOWNLOAD.exec(output)?.[1] ?? GEODATA_ATTEMPT.exec(output)?.[1];
  return kind ? GEODATA_CLASS_FILES[kind.toLowerCase()] : undefined;
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
