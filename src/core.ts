import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { extractCoreArchive } from "./core-archive.js";
import {
  currentCoreVersion,
  readInstallRecord,
  validateCoreReleaseTag,
  writeInstallRecord,
} from "./core-install-record.js";
import { pathEntryExists } from "./fs-atomic.js";

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
      fs.chmodSync(stagedExe, 0o755);
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
