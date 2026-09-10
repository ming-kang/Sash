import fs from "node:fs";
import path from "node:path";
import { extractCoreArchive } from "./core-archive.js";
import {
  currentCoreVersion,
  readInstallRecord,
  validateCoreReleaseTag,
  writeInstallRecord,
} from "./core-install-record.js";
import { type Amd64Level, detectAmd64Level } from "./cpu-features.js";
import { pathEntryExists } from "./fs-atomic.js";
import {
  downloadReleaseAsset,
  listReleaseAssets,
  MIHOMO_REPO,
  type ReleaseAsset,
  resolveLatestTag,
} from "./github.js";
import { type SashLayout, sashLayout } from "./paths.js";

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
 * Choose the highest supported official build. Unknown capabilities only
 * admit baseline builds; the upstream plain amd64 asset requires v3.
 */
export function mihomoAssetCandidates(
  tag: string,
  platform = process.platform,
  arch = process.arch,
  level?: Amd64Level,
): string[] {
  const { os, arch: goArch } = goOsArch(platform, arch);
  const ext = platform === "win32" ? "zip" : "gz";
  if (goArch === "amd64") {
    const variants =
      level === 3
        ? ["v3", "", "v2", "v1", "compatible"]
        : level === 2
          ? ["v2", "v1", "compatible"]
          : level === 1
            ? ["v1", "compatible"]
            : ["compatible", "v1"];
    return variants.map(
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
  const [assets, level] = await Promise.all([
    listReleaseAssets(MIHOMO_REPO, tag, options.signal),
    detectAmd64Level(),
  ]);
  return {
    tag,
    assets,
    candidates: mihomoAssetCandidates(tag, process.platform, process.arch, level),
  };
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
    await extractCoreArchive(archivePath, assetName, stagedExe, opts.signal);
    opts.signal?.throwIfAborted();
    fs.chmodSync(stagedExe, 0o755);
    return { version: tag, exe: stagedExe, assetName };
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
