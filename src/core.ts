import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import AdmZip from "adm-zip";
import { atomicWriteFileSync } from "./fs-atomic.js";
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
 * Asset name candidates in preference order. mihomo publishes many amd64
 * micro-architecture/toolchain variants; the plain name is the default build,
 * `compatible` runs on pre-v3 CPUs, `v1` is the baseline x86-64 build.
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
      `mihomo-${os}-amd64-${tag}.${ext}`,
      `mihomo-${os}-amd64-compatible-${tag}.${ext}`,
      `mihomo-${os}-amd64-v1-${tag}.${ext}`,
    ];
  }
  return [`mihomo-${os}-arm64-${tag}.${ext}`];
}

const EXTRACT_SIZE_LIMIT = 512 * 1024 * 1024;

/** Extract the binary from a downloaded .zip (windows) or .gz (single file). */
export async function extractCoreArchive(
  archivePath: string,
  assetName: string,
  destExe: string,
): Promise<void> {
  const extracted = `${destExe}.extracted`;
  try {
    if (assetName.endsWith(".zip")) {
      if (fs.statSync(archivePath).size > RELEASE_ASSET_SIZE_LIMIT) {
        throw new Error("Core archive exceeds the download safety limit");
      }
      const zip = new AdmZip(archivePath);
      const executables = zip
        .getEntries()
        .filter((e) => !e.isDirectory && /\.exe$/i.test(e.entryName));
      const entry =
        executables.find((e) => /^mihomo.*\.exe$/i.test(path.basename(e.entryName))) ??
        executables[0];
      if (!entry) throw new Error(`No .exe found inside ${assetName}`);
      if (entry.header.size > EXTRACT_SIZE_LIMIT) {
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
      let bytes = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > EXTRACT_SIZE_LIMIT) {
            callback(new Error("Extracted binary exceeds 512MB safety limit"));
            return;
          }
          callback(null, chunk);
        },
      });
      const output = fs.createWriteStream(extracted, { mode: 0o755 });
      if (header.method === 0) {
        await pipeline(Readable.from([compressed]), limiter, output);
      } else {
        await pipeline(Readable.from([compressed]), zlib.createInflateRaw(), limiter, output);
      }
    } else if (assetName.endsWith(".gz")) {
      // Stream decompression with a hard size cap instead of buffering the
      // whole archive in memory.
      let bytes = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > EXTRACT_SIZE_LIMIT) {
            callback(new Error("Extracted binary exceeds 512MB safety limit"));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        fs.createReadStream(archivePath),
        zlib.createGunzip(),
        limiter,
        fs.createWriteStream(extracted, { mode: 0o755 }),
      );
    } else {
      throw new Error(`Unsupported archive type: ${assetName}`);
    }
    fs.renameSync(extracted, destExe);
  } catch (err) {
    fs.rmSync(extracted, { force: true });
    throw err;
  }
}

export interface InstallRecord {
  coreVersion: string;
  installedAt: string;
}

export function readInstallRecord(layout: SashLayout = sashLayout()): InstallRecord | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(layout.installFile, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "coreVersion" && key !== "installedAt")) {
      return undefined;
    }
    if (typeof record.coreVersion !== "string" || typeof record.installedAt !== "string") {
      return undefined;
    }
    const coreVersion = validateCoreReleaseTag(record.coreVersion);
    const installedAt = record.installedAt;
    if (
      !Number.isFinite(Date.parse(installedAt)) ||
      new Date(installedAt).toISOString() !== installedAt
    ) {
      return undefined;
    }
    return { coreVersion, installedAt };
  } catch {
    return undefined;
  }
}

export function writeInstallRecord(record: InstallRecord, layout: SashLayout = sashLayout()): void {
  const coreVersion = validateCoreReleaseTag(record.coreVersion);
  if (
    !Number.isFinite(Date.parse(record.installedAt)) ||
    new Date(record.installedAt).toISOString() !== record.installedAt
  ) {
    throw new Error(`Invalid Core install timestamp: ${record.installedAt}`);
  }
  atomicWriteFileSync(
    layout.installFile,
    `${JSON.stringify({ coreVersion, installedAt: record.installedAt }, null, 2)}\n`,
  );
}

/** Best-effort current core version, read from the install record ("" when absent). */
export function currentCoreVersion(layout: SashLayout = sashLayout()): string {
  const record = readInstallRecord(layout);
  if (record?.coreVersion) return record.coreVersion;
  return "";
}

export interface CoreInstallOptions {
  layout?: SashLayout;
  /** Specific tag to install (e.g. v1.19.30); defaults to latest. */
  tag?: string;
  onProgress?: (downloaded: number, total: number | undefined) => void;
}

export interface StagedCore {
  version: string;
  exe: string;
}

export function validateCoreReleaseTag(tag: string): string {
  const normalized = tag.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error(`Invalid Core release tag: ${tag}`);
  }
  return normalized;
}

/** Execute a staged binary before it is allowed to replace the installed core. */
function versionOutputMatches(output: string, expected: string): boolean {
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9._-])${escaped}($|[^A-Za-z0-9._-])`).test(output);
}

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
    if (expectedVersion && !versionOutputMatches(output, expectedVersion)) {
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
  const tag = validateCoreReleaseTag(opts.tag ?? (await resolveLatestTag(MIHOMO_REPO)));
  const assets = await listReleaseAssets(MIHOMO_REPO, tag);
  const candidates = mihomoAssetCandidates(tag);

  fs.mkdirSync(layout.tempDir, { recursive: true });
  fs.mkdirSync(layout.binDir, { recursive: true });
  const archivePath = path.join(layout.tempDir, `mihomo-${tag}-${process.pid}.download`);
  const stagedExe = `${layout.coreExe}.${process.pid}.new`;
  try {
    const assetName = await downloadReleaseAsset({
      repo: MIHOMO_REPO,
      tag,
      assets,
      candidates,
      dest: archivePath,
      onProgress: opts.onProgress,
    });
    await extractCoreArchive(archivePath, assetName, stagedExe);
    fs.chmodSync(stagedExe, 0o755);
    verifyCoreExecutable(stagedExe, 5000, tag);
    return { version: tag, exe: stagedExe };
  } catch (err) {
    fs.rmSync(stagedExe, { force: true });
    throw err;
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

/** Download and install a core when no previous binary exists. */
export async function installCore(
  opts: CoreInstallOptions = {},
): Promise<{ version: string; exe: string }> {
  const layout = opts.layout ?? sashLayout();
  if (fs.existsSync(layout.coreExe)) {
    throw new Error(`Core executable already exists at ${layout.coreExe}; use the update flow`);
  }
  const staged = await stageCore({ ...opts, layout });
  try {
    fs.renameSync(staged.exe, layout.coreExe);
    writeInstallRecord(
      { coreVersion: staged.version, installedAt: new Date().toISOString() },
      layout,
    );
    return { version: staged.version, exe: layout.coreExe };
  } finally {
    fs.rmSync(staged.exe, { force: true });
  }
}

export function coreInstalled(layout: SashLayout = sashLayout()): boolean {
  return fs.existsSync(layout.coreExe);
}
