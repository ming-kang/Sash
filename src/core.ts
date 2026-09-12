import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { type Entry, openPromise, type ZipFile } from "yauzl";
import { atomicWriteFileSync, pathEntryExists } from "./fs-atomic.js";
import {
  downloadReleaseAsset,
  listReleaseAssets,
  MIHOMO_REPO,
  type ReleaseAsset,
  resolveLatestTag,
} from "./github.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { buildSanitizedEnv } from "./process.js";

/**
 * Mihomo core acquisition: platform asset selection, verified download,
 * decompression, install records, and atomic install/update with rollback.
 */

export function goOsArch(
  platform = process.platform,
  arch = process.arch,
): { os: string; arch: string } {
  const osMap: Record<string, string> = { win32: "windows", darwin: "darwin", linux: "linux" };
  const archMap: Record<string, string> = { x64: "amd64", arm64: "arm64" };
  const goOs = osMap[platform];
  const goArch = archMap[arch];
  if (!goOs || !goArch) {
    throw new Error(
      `Unsupported platform: ${platform}/${arch} (supported: win32/darwin/linux × x64/arm64)`,
    );
  }
  return { os: goOs, arch: goArch };
}

/**
 * Newest ISA level first. stageCore preflights each staged build and falls
 * through to the next variant when this processor rejects it, so no CPU
 * feature detection is needed up front.
 */
export function mihomoAssetCandidates(
  tag: string,
  platform = process.platform,
  arch = process.arch,
): string[] {
  const { os, arch: goArch } = goOsArch(platform, arch);
  const ext = platform === "win32" ? "zip" : "gz";
  if (goArch === "amd64") {
    return ["v3", "", "v2", "v1", "compatible"].map(
      (variant) => `mihomo-${os}-amd64-${variant ? `${variant}-` : ""}${tag}.${ext}`,
    );
  }
  return [`mihomo-${os}-arm64-${tag}.${ext}`];
}

export const CORE_BINARY_SIZE_LIMIT = 512 * 1024 * 1024;

/** Require a nonempty regular executable within the size limit. */
export function assertCoreBinaryFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > CORE_BINARY_SIZE_LIMIT)
    throw new Error(`Core binary must be a nonempty regular file within 512MB: ${file}`);
}

export interface InstallRecord {
  coreVersion: string;
}

export function validateCoreReleaseTag(tag: string): string {
  const normalized = tag.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error(`Invalid Core release tag: ${tag}`);
  }
  return normalized;
}

function toInstallRecord(value: unknown): InstallRecord {
  const source = value as Record<string, unknown>;
  return { coreVersion: validateCoreReleaseTag(String(source?.coreVersion ?? "")) };
}

/** Lenient read used for private journals and for the committed installation record. */
export function parseInstallRecord(value: unknown): InstallRecord | undefined {
  const source = value as Record<string, unknown> | null;
  if (typeof source?.coreVersion !== "string") return undefined;
  try {
    return toInstallRecord(value);
  } catch {
    return undefined;
  }
}

/** Best-effort read; an unreadable record means "no Core installed". */
export function readInstallRecord(layout: SashLayout = sashLayout()): InstallRecord | undefined {
  try {
    return parseInstallRecord(JSON.parse(fs.readFileSync(layout.installFile, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

export function writeInstallRecord(record: InstallRecord, layout: SashLayout = sashLayout()): void {
  const normalized = toInstallRecord(record);
  atomicWriteFileSync(layout.installFile, `${JSON.stringify(normalized, null, 2)}\n`);
}

/** Best-effort current Core version, read from the committed install record. */
export function currentCoreVersion(layout: SashLayout = sashLayout()): string {
  return readInstallRecord(layout)?.coreVersion ?? "";
}

function extractionLimiter(): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > CORE_BINARY_SIZE_LIMIT) {
        callback(new Error("Extracted binary exceeds 512MB safety limit"));
        return;
      }
      callback(null, chunk);
    },
  });
}

/** Read archive entries only; Sash exclusively creates and owns the output file. */
export async function extractCoreArchive(
  archivePath: string,
  assetName: string,
  destExe: string,
  signal?: AbortSignal,
): Promise<void> {
  const extracted = `${destExe}.extracted`;
  let created = false;
  let zip: ZipFile | undefined;
  let closed: Promise<void> | undefined;
  let input: Readable | undefined;
  const transforms: Transform[] = [];
  try {
    signal?.throwIfAborted();
    if (!assetName.endsWith(".zip") && !assetName.endsWith(".gz"))
      throw new Error(`Unsupported archive type: ${assetName}`);
    if (assetName.endsWith(".zip")) {
      zip = await openPromise(archivePath, {
        autoClose: false,
        strictFileNames: true,
        validateEntrySizes: true,
      });
      closed = new Promise<void>((resolve) => zip?.once("close", resolve));
      let executable: Entry | undefined;
      // Scan every name before creating output, including entries after the executable.
      for await (const entry of zip.eachEntry()) {
        signal?.throwIfAborted();
        if (
          entry.fileName.split(/[\\/]/).includes("..") ||
          /^(?:[\\/]|[A-Za-z]:)/.test(entry.fileName) ||
          entry.fileName.includes("\0")
        )
          throw new Error("Core archive contains an unsafe path");
        if (
          !executable &&
          !entry.fileName.endsWith("/") &&
          /^mihomo.*\.exe$/i.test(path.posix.basename(entry.fileName))
        )
          executable = entry;
      }
      if (!executable) throw new Error(`No mihomo*.exe found inside ${assetName}`);
      input = await zip.openReadStreamPromise(executable);
    } else {
      input = fs.createReadStream(archivePath);
      transforms.push(zlib.createGunzip());
    }
    signal?.throwIfAborted();
    const fd = fs.openSync(extracted, "wx", 0o755);
    created = true;
    let output: fs.WriteStream;
    try {
      output = fs.createWriteStream(extracted, { fd, autoClose: true });
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
    await pipeline([input, ...transforms, extractionLimiter(), output], { signal });
    signal?.throwIfAborted();
    fs.renameSync(extracted, destExe);
  } catch (error) {
    if (created) fs.rmSync(extracted, { force: true });
    throw error;
  } finally {
    input?.destroy();
    if (zip) {
      zip.close();
      await closed;
    }
  }
}

export interface CoreInstallOptions {
  signal?: AbortSignal;
  layout?: SashLayout;
  /** Specific tag to install (e.g. v1.19.30); defaults to latest. */
  tag?: string;
  onProgress?: (downloaded: number, total: number | undefined) => void;
  onStage?: (stage: "resolving" | "downloading" | "extracting", target?: string) => void;
}

export interface StagedCore {
  version: string;
  exe: string;
  assetName?: string;
}

export interface CoreReleaseResolution {
  tag: string;
  assets: ReleaseAsset[];
  candidates: string[];
}

/**
 * Resolve one release to its assets and the compatible asset names for this
 * machine. Both the staging path and the metadata-only check use this so the
 * size/digest and CPU-feature policy cannot drift apart.
 */
export async function resolveCoreRelease(
  options: { tag?: string; signal?: AbortSignal } = {},
): Promise<CoreReleaseResolution> {
  const tag = validateCoreReleaseTag(
    options.tag ?? (await resolveLatestTag(MIHOMO_REPO, options.signal)),
  );
  const assets = await listReleaseAssets(MIHOMO_REPO, tag, options.signal);
  return {
    tag,
    assets,
    candidates: mihomoAssetCandidates(tag, process.platform, process.arch),
  };
}

/**
 * Preflight a staged build: a processor that lacks the build's instruction
 * set kills it with an illegal-instruction exit, and any other non-zero exit
 * means this variant cannot serve this machine either.
 */
export async function coreBinaryRuns(exe: string): Promise<boolean> {
  try {
    const child = spawn(exe, ["-v"], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
      env: buildSanitizedEnv(),
      timeout: 10_000,
    });
    return await new Promise<boolean>((resolve) => {
      child.on("error", () => resolve(false));
      child.on("close", (code, signal) => resolve(code === 0 && signal === null));
    });
  } catch {
    return false;
  }
}

/** Verify the download and extract it without changing the installed runtime. */
export async function stageCore(opts: CoreInstallOptions = {}): Promise<StagedCore> {
  const layout = opts.layout ?? sashLayout();
  opts.onStage?.("resolving");
  const { tag, assets, candidates } = await resolveCoreRelease({
    ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  fs.mkdirSync(layout.tempDir, { recursive: true });
  const directory = fs.mkdtempSync(path.join(layout.tempDir, "core-download-"));
  const archivePath = path.join(directory, "archive.download");
  const stagedExe = path.join(directory, path.basename(layout.coreExe));
  try {
    const available = candidates.filter((name) => assets.some((asset) => asset.name === name));
    if (available.length === 0) {
      throw new Error(
        `No trusted release asset matched ${candidates.join(", ")} for ${MIHOMO_REPO}@${tag}`,
      );
    }
    for (const assetName of available) {
      // Only a failed preflight falls through to the next build; download,
      // integrity and extraction errors abort the staging.
      opts.onStage?.("downloading", tag);
      await downloadReleaseAsset({
        signal: opts.signal,
        repo: MIHOMO_REPO,
        tag,
        assets,
        candidates: [assetName],
        dest: archivePath,
        onProgress: opts.onProgress,
      });
      opts.onStage?.("extracting", tag);
      await extractCoreArchive(archivePath, assetName, stagedExe, opts.signal);
      opts.signal?.throwIfAborted();
      if (await coreBinaryRuns(stagedExe)) return { version: tag, exe: stagedExe, assetName };
      fs.rmSync(stagedExe, { force: true });
    }
    throw new Error(
      `No published Core build runs on this processor (tried ${available.join(", ")}).`,
    );
  } catch (err) {
    fs.rmSync(stagedExe, { force: true });
    throw err;
  } finally {
    fs.rmSync(archivePath, { force: true });
    try {
      fs.rmdirSync(directory);
    } catch {
      /* Successful staging still owns its executable. */
    }
  }
}

function isRegularFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

export function coreInstalled(layout: SashLayout = sashLayout()): boolean {
  return isRegularFile(layout.coreExe) && readInstallRecord(layout) !== undefined;
}

/** Fail closed when binary and committed install metadata do not agree. */
export function assertCoreInstallationConsistent(layout: SashLayout = sashLayout()): void {
  const binaryExists = pathEntryExists(layout.coreExe);
  const installRecordExists = pathEntryExists(layout.installFile);
  const binaryValid = isRegularFile(layout.coreExe);
  const record = readInstallRecord(layout);

  if (!binaryExists && !installRecordExists) return;
  if (binaryValid && record) return;

  const reason = binaryExists
    ? record
      ? "the Core executable is not a regular file"
      : "the Core executable exists without valid install metadata"
    : record
      ? "Core install metadata exists but the executable is missing"
      : "Core install metadata is malformed without an executable";
  throw new Error(
    `Core installation is incomplete or invalid: ${reason}. Preserve these files and reinstall into a clean data directory.`,
  );
}
