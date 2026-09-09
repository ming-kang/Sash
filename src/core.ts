import { execFileSync } from "node:child_process";
import crypto, { type Hash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import AdmZip from "adm-zip";
import {
  currentCoreVersion,
  readInstallRecord,
  validateCoreReleaseTag,
  writeInstallRecord,
} from "./core-install-record.js";
import { assertCoreBinaryDigest, CORE_BINARY_SIZE_LIMIT } from "./core-integrity.js";
import { containsCoreVersionToken } from "./core-version.js";
import { pathEntryExists } from "./fs-atomic.js";
import {
  downloadReleaseAsset,
  listReleaseAssets,
  MIHOMO_REPO,
  RELEASE_ASSET_SIZE_LIMIT,
  resolveLatestTag,
} from "./github.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { buildSanitizedEnv } from "./process.js";

/**
 * Mihomo core acquisition: platform asset selection, download, decompression,
 * and atomic install/update with rollback.
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
 * Asset name candidates in preference order. The upstream plain amd64 asset
 * requires x86-64-v3; Sash defaults to the broadly compatible/v1 builds and
 * keeps the optimized plain asset only as a last availability fallback.
 */
export function mihomoAssetCandidates(
  tag: string,
  platform = process.platform,
  arch = process.arch,
): string[] {
  const { os, arch: goArch } = goOsArch(platform, arch);
  const ext = platform === "win32" ? "zip" : "gz";
  if (goArch === "amd64") {
    return [
      `mihomo-${os}-amd64-compatible-${tag}.${ext}`,
      `mihomo-${os}-amd64-v1-${tag}.${ext}`,
      `mihomo-${os}-amd64-${tag}.${ext}`,
    ];
  }
  return [`mihomo-${os}-arm64-${tag}.${ext}`];
}

function createCoreExtractionLimiter(hash: Hash): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > CORE_BINARY_SIZE_LIMIT) {
        callback(new Error("Extracted binary exceeds 512MB safety limit"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

/** Extract the binary from a downloaded .zip (windows) or .gz (single file). */
export async function extractCoreArchive(
  archivePath: string,
  assetName: string,
  destExe: string,
): Promise<string> {
  const extracted = `${destExe}.extracted`;
  const hash = crypto.createHash("sha256");
  try {
    if (assetName.endsWith(".zip")) {
      if (fs.statSync(archivePath).size > RELEASE_ASSET_SIZE_LIMIT) {
        throw new Error("Core archive exceeds the download safety limit");
      }
      const zip = new AdmZip(archivePath);
      const entries = zip.getEntries();
      if (
        entries.some(
          (entry) =>
            entry.entryName.split(/[\\/]/).includes("..") ||
            /^(?:[\\/]|[A-Za-z]:)/.test(entry.entryName),
        )
      ) {
        throw new Error("Core archive contains an unsafe path");
      }
      const entry = entries.find(
        (candidate) =>
          !candidate.isDirectory && /^mihomo.*\.exe$/i.test(path.basename(candidate.entryName)),
      );
      if (!entry) throw new Error(`No mihomo*.exe found inside ${assetName}`);
      if (entry.header.size > CORE_BINARY_SIZE_LIMIT) {
        throw new Error("Extracted binary exceeds 512MB safety limit");
      }
      const header = entry.header as typeof entry.header & { readonly encrypted?: boolean };
      if (header.encrypted) {
        throw new Error("Encrypted Core archives are not supported");
      }
      if (header.method !== 0 && header.method !== 8) {
        throw new Error(`Unsupported ZIP compression method: ${header.method}`);
      }
      const compressed = entry.getCompressedData();
      const output = fs.createWriteStream(extracted, { mode: 0o755 });
      if (header.method === 0) {
        await pipeline(Readable.from([compressed]), createCoreExtractionLimiter(hash), output);
      } else {
        await pipeline(
          Readable.from([compressed]),
          zlib.createInflateRaw(),
          createCoreExtractionLimiter(hash),
          output,
        );
      }
    } else if (assetName.endsWith(".gz")) {
      // Stream decompression with a hard size cap instead of buffering the
      // whole archive in memory.
      await pipeline(
        fs.createReadStream(archivePath),
        zlib.createGunzip(),
        createCoreExtractionLimiter(hash),
        fs.createWriteStream(extracted, { mode: 0o755 }),
      );
    } else {
      throw new Error(`Unsupported archive type: ${assetName}`);
    }
    fs.renameSync(extracted, destExe);
    return hash.digest("hex");
  } catch (err) {
    fs.rmSync(extracted, { force: true });
    throw err;
  }
}

export type { InstallRecord } from "./core-install-record.js";
export { currentCoreVersion, readInstallRecord, validateCoreReleaseTag, writeInstallRecord };

export interface CoreInstallOptions {
  signal?: AbortSignal;
  layout?: SashLayout;
  /** Specific tag to install (e.g. v1.19.30); defaults to latest. */
  tag?: string;
  onProgress?: (downloaded: number, total: number | undefined) => void;
  onStage?: (
    stage: "resolving" | "downloading" | "extracting" | "verifying",
    target?: string,
  ) => void;
}

export interface StagedCore {
  version: string;
  exe: string;
  sha256: string;
}

/** Execute a staged binary before it is allowed to replace the installed core. */
export function verifyCoreExecutable(
  exe: string,
  timeoutMs = 5000,
  expectedVersion?: string,
): void {
  try {
    const output = execFileSync(exe, ["-v"], {
      encoding: "utf8",
      env: buildSanitizedEnv(),
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (expectedVersion && !containsCoreVersionToken(output, expectedVersion)) {
      throw new Error(
        `version output does not contain expected release ${expectedVersion}: ${output.trim()}`,
      );
    }
  } catch (err) {
    throw new Error(`Downloaded core binary failed validation: ${(err as Error).message}`);
  }
}

/** Download, extract and validate a core binary without changing installed state. */
export async function stageCore(opts: CoreInstallOptions = {}): Promise<StagedCore> {
  const layout = opts.layout ?? sashLayout();
  opts.onStage?.("resolving");
  const tag = validateCoreReleaseTag(
    opts.tag ?? (await resolveLatestTag(MIHOMO_REPO, opts.signal)),
  );
  const assets = await listReleaseAssets(MIHOMO_REPO, tag, opts.signal);
  const candidates = mihomoAssetCandidates(tag);

  fs.mkdirSync(layout.tempDir, { recursive: true });
  fs.mkdirSync(layout.binDir, { recursive: true });
  const directory = fs.mkdtempSync(path.join(layout.tempDir, "core-download-"));
  const archivePath = path.join(directory, "archive.download");
  const stagedExe = path.join(directory, path.basename(layout.coreExe));
  try {
    opts.onStage?.("downloading", tag);
    const assetName = await downloadReleaseAsset({
      signal: opts.signal,
      repo: MIHOMO_REPO,
      tag,
      assets,
      candidates,
      dest: archivePath,
      onProgress: opts.onProgress,
    });
    opts.onStage?.("extracting", tag);
    const sha256 = await extractCoreArchive(archivePath, assetName, stagedExe);
    opts.signal?.throwIfAborted();
    fs.chmodSync(stagedExe, 0o755);
    opts.onStage?.("verifying", tag);
    assertCoreBinaryDigest(stagedExe, sha256);
    verifyCoreExecutable(stagedExe, 5000, tag);
    return { version: tag, exe: stagedExe, sha256 };
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
  if (binaryValid && record) {
    if (record.sha256) assertCoreBinaryDigest(layout.coreExe, record.sha256);
    return;
  }

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
