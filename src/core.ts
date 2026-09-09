import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { extractCoreArchive } from "./core-archive.js";
import {
  currentCoreVersion,
  readInstallRecord,
  validateCoreReleaseTag,
  writeInstallRecord,
} from "./core-install-record.js";
import { assertCoreBinaryDigest } from "./core-integrity.js";
import { containsCoreVersionToken } from "./core-version.js";
import { pathEntryExists } from "./fs-atomic.js";
import {
  downloadReleaseAsset,
  listReleaseAssets,
  MIHOMO_REPO,
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

export type { InstallRecord } from "./core-install-record.js";
export {
  currentCoreVersion,
  extractCoreArchive,
  readInstallRecord,
  validateCoreReleaseTag,
  writeInstallRecord,
};

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
    const sha256 = await extractCoreArchive(archivePath, assetName, stagedExe, opts.signal);
    opts.signal?.throwIfAborted();
    fs.chmodSync(stagedExe, 0o755);
    opts.onStage?.("verifying", tag);
    assertCoreBinaryDigest(stagedExe, sha256);
    // First execution can wait on the desktop antivirus scan of a new download.
    verifyCoreExecutable(stagedExe, 20_000, tag);
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
