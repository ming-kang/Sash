import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import AdmZip from "adm-zip";
import { atomicWriteFileSync } from "./fs-atomic.js";
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
      const data = entry.getData();
      if (data.length > EXTRACT_SIZE_LIMIT) {
        throw new Error("Extracted binary exceeds 512MB safety limit");
      }
      fs.writeFileSync(extracted, data, { mode: 0o755 });
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
    return JSON.parse(fs.readFileSync(layout.installFile, "utf8")) as InstallRecord;
  } catch {
    return undefined;
  }
}

export function writeInstallRecord(record: InstallRecord, layout: SashLayout = sashLayout()): void {
  atomicWriteFileSync(layout.installFile, `${JSON.stringify(record, null, 2)}\n`);
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

/** Execute a staged binary before it is allowed to replace the installed core. */
export function verifyCoreExecutable(exe: string, timeoutMs = 5000): void {
  try {
    execFileSync(exe, ["-v"], {
      encoding: "utf8",
      env: buildSanitizedEnv(),
      timeout: timeoutMs,
      windowsHide: true,
    });
  } catch (err) {
    throw new Error(`Downloaded core binary failed validation: ${(err as Error).message}`);
  }
}

/** Download, extract and validate a core binary without changing installed state. */
export async function stageCore(opts: CoreInstallOptions = {}): Promise<StagedCore> {
  const layout = opts.layout ?? sashLayout();
  const tag = opts.tag ?? (await resolveLatestTag(MIHOMO_REPO));
  const assets = await listReleaseAssets(MIHOMO_REPO, tag).catch(() => []);
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
    verifyCoreExecutable(stagedExe);
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
