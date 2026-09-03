import { execFileSync } from "node:child_process";
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
import {
  beginCoreInstallTransaction,
  clearCoreInstallTransaction,
  markCoreInstallTransactionCommitted,
  recoverCoreInstallTransaction,
} from "./core-install-transaction.js";
import { containsCoreVersionToken } from "./core-version.js";
import { durableRenameSync, pathEntryExists } from "./fs-atomic.js";
import {
  downloadReleaseAsset,
  listReleaseAssets,
  MIHOMO_REPO,
  RELEASE_ASSET_SIZE_LIMIT,
  resolveLatestTag,
} from "./github.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { buildSanitizedEnv, recoverBinaryUnlockProbe } from "./process.js";

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

const EXTRACT_SIZE_LIMIT = 512 * 1024 * 1024;

function createCoreExtractionLimiter(): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > EXTRACT_SIZE_LIMIT) {
        callback(new Error("Extracted binary exceeds 512MB safety limit"));
        return;
      }
      callback(null, chunk);
    },
  });
}

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
      const entry = zip
        .getEntries()
        .find(
          (candidate) =>
            !candidate.isDirectory && /^mihomo.*\.exe$/i.test(path.basename(candidate.entryName)),
        );
      if (!entry) throw new Error(`No mihomo*.exe found inside ${assetName}`);
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
      const output = fs.createWriteStream(extracted, { mode: 0o755 });
      if (header.method === 0) {
        await pipeline(Readable.from([compressed]), createCoreExtractionLimiter(), output);
      } else {
        await pipeline(
          Readable.from([compressed]),
          zlib.createInflateRaw(),
          createCoreExtractionLimiter(),
          output,
        );
      }
    } else if (assetName.endsWith(".gz")) {
      // Stream decompression with a hard size cap instead of buffering the
      // whole archive in memory.
      await pipeline(
        fs.createReadStream(archivePath),
        zlib.createGunzip(),
        createCoreExtractionLimiter(),
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

export type { InstallRecord } from "./core-install-record.js";
export { currentCoreVersion, readInstallRecord, validateCoreReleaseTag, writeInstallRecord };

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
  recoverCoreInstallTransaction(layout);
  assertCoreInstallationConsistent(layout);
  if (coreInstalled(layout)) {
    throw new Error(`Core executable already exists at ${layout.coreExe}; use the update flow`);
  }
  const staged = await stageCore({ ...opts, layout });
  let transactionStarted = false;
  let committed = false;
  try {
    const transaction = beginCoreInstallTransaction(staged.version, layout);
    transactionStarted = true;
    durableRenameSync(staged.exe, layout.coreExe);
    writeInstallRecord({ coreVersion: staged.version, installedAt: transaction.createdAt }, layout);
    markCoreInstallTransactionCommitted(transaction, layout);
    committed = true;
    clearCoreInstallTransaction(layout);
    return { version: staged.version, exe: layout.coreExe };
  } catch (err) {
    if (transactionStarted && !committed) {
      try {
        recoverCoreInstallTransaction(layout);
      } catch (recoveryErr) {
        throw new Error(
          `${(err as Error).message}; Core install recovery also failed: ${(recoveryErr as Error).message}`,
        );
      }
    }
    throw err;
  } finally {
    fs.rmSync(staged.exe, { force: true });
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
  recoverBinaryUnlockProbe(layout.coreExe);
  const binaryExists = pathEntryExists(layout.coreExe);
  const installRecordExists = pathEntryExists(layout.installFile);
  const binaryValid = isRegularFile(layout.coreExe);
  const record = readInstallRecord(layout);

  if ((!binaryExists && !installRecordExists) || (binaryValid && record)) return;

  const reason = binaryExists
    ? record
      ? "the Core executable is not a regular file"
      : "the Core executable exists without valid install metadata"
    : record
      ? "Core install metadata exists but the executable is missing"
      : "Core install metadata is malformed without an executable";
  throw new Error(
    `Core installation is incomplete or invalid: ${reason}. Run \`sash update --force\` to repair it.`,
  );
}
