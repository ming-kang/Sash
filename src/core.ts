import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { type Entry, openPromise, type ZipFile } from "yauzl";
import { manifestReleaseAssets, readBootstrapManifest } from "./bootstrap-manifest.js";
import { atomicWriteFileSync, pathEntryExists } from "./fs-atomic.js";
import {
  downloadReleaseAsset,
  listReleaseAssets,
  MIHOMO_REPO,
  type ReleaseAsset,
  resolveLatestTag,
  validateCoreReleaseTag,
} from "./github.js";
import type { ProxyFallbackListener } from "./http.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { buildSanitizedEnv } from "./process.js";

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

/** Newest ISA level first; stageCore preflights each build and falls through when this processor rejects it. */
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

export function assertCoreBinaryFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > CORE_BINARY_SIZE_LIMIT)
    throw new Error(`Core binary must be a nonempty regular file within 512MB: ${file}`);
}

export { validateCoreReleaseTag } from "./github.js";

export interface InstallRecord {
  coreVersion: string;
}

function toInstallRecord(value: unknown): InstallRecord {
  const source = value as Record<string, unknown>;
  return { coreVersion: validateCoreReleaseTag(String(source?.coreVersion ?? "")) };
}

/** Lenient read: a malformed record reads as absent. */
export function parseInstallRecord(value: unknown): InstallRecord | undefined {
  const source = value as Record<string, unknown> | null;
  if (typeof source?.coreVersion !== "string") return undefined;
  try {
    return toInstallRecord(value);
  } catch {
    return undefined;
  }
}

export function readInstallRecord(layout: SashLayout = sashLayout()): InstallRecord | undefined {
  try {
    return parseInstallRecord(JSON.parse(fs.readFileSync(layout.installFile, "utf8")));
  } catch {
    return undefined;
  }
}

export function writeInstallRecord(record: InstallRecord, layout: SashLayout = sashLayout()): void {
  const normalized = toInstallRecord(record);
  atomicWriteFileSync(layout.installFile, `${JSON.stringify(normalized, null, 2)}\n`);
}

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
  tag?: string;
  /** Route GitHub traffic through this proxy instead of the environment proxy. */
  proxyUri?: string;
  onProgress?: (downloaded: number, total: number | undefined) => void;
  onStage?: (stage: "resolving" | "downloading" | "extracting", target?: string) => void;
  onProxyFallback?: ProxyFallbackListener;
}

export interface StagedCore {
  version: string;
  exe: string;
  /** The private directory `exe` was staged into; the consumer removes it wholesale. */
  dir: string;
  assetName?: string;
  /** "pinned" when staging used the packaged bootstrap manifest offline. */
  source?: "live" | "pinned";
}

export interface CoreReleaseResolution {
  tag: string;
  assets: ReleaseAsset[];
  candidates: string[];
  /** "pinned" when the metadata came from the packaged bootstrap manifest, not the live API. */
  source: "live" | "pinned";
}

/**
 * Resolve one release to its assets and the compatible asset names for this
 * machine; the staging path and the metadata-only check share it so their digest
 * and CPU-feature policy cannot drift apart. When the live release API is
 * unreachable, the packaged bootstrap manifest supplies the same metadata for
 * the one release it records.
 */
export async function resolveCoreRelease(
  options: {
    tag?: string;
    signal?: AbortSignal;
    proxyUri?: string;
    onProxyFallback?: ProxyFallbackListener;
  } = {},
): Promise<CoreReleaseResolution> {
  const pinned = options.tag ?? process.env.SASH_CORE_VERSION;
  // An invalid explicit pin is a usage error, never a network problem.
  if (pinned !== undefined) validateCoreReleaseTag(pinned);
  try {
    const tag = validateCoreReleaseTag(
      pinned ??
        (await resolveLatestTag(
          MIHOMO_REPO,
          options.signal,
          options.onProxyFallback,
          options.proxyUri,
        )),
    );
    const assets = await listReleaseAssets(
      MIHOMO_REPO,
      tag,
      options.signal,
      options.onProxyFallback,
      options.proxyUri,
    );
    return {
      tag,
      assets,
      candidates: mihomoAssetCandidates(tag, process.platform, process.arch),
      source: "live",
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    const manifest = readBootstrapManifest();
    if (manifest && (pinned === undefined || pinned === manifest.core.tag)) {
      return {
        tag: manifest.core.tag,
        assets: manifestReleaseAssets(MIHOMO_REPO, manifest.core),
        candidates: mihomoAssetCandidates(manifest.core.tag, process.platform, process.arch),
        source: "pinned",
      };
    }
    throw explainCoreReleaseFailure(error);
  }
}

export const OFFLINE_CORE_INSTALL_URL =
  "https://github.com/ming-kang/Sash/blob/main/docs/usage.md#install-core-offline";

function explainCoreReleaseFailure(error: unknown): unknown {
  if (!(error instanceof Error) || error.name === "AbortError") return error;
  const message = error.message;
  if (
    message.includes("HTTP_PROXY") ||
    message.startsWith("Invalid Core release tag") ||
    message.startsWith("GitHub release response")
  ) {
    return error;
  }
  if (/HTTP (403|429)\b/.test(message)) {
    return new Error(
      `${message} — the GitHub API rate limit was reached; set GITHUB_TOKEN and retry`,
      { cause: error },
    );
  }
  return new Error(
    `${message} — cannot reach GitHub; set HTTP_PROXY to a running proxy, or install Core manually: ${OFFLINE_CORE_INSTALL_URL}`,
    { cause: error },
  );
}

/** Preflight a staged build: a processor lacking the build's instruction set kills it with an illegal-instruction exit. */
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

export async function stageCore(opts: CoreInstallOptions = {}): Promise<StagedCore> {
  const layout = opts.layout ?? sashLayout();
  opts.onStage?.("resolving");
  const { tag, assets, candidates, source } = await resolveCoreRelease({
    ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.proxyUri !== undefined ? { proxyUri: opts.proxyUri } : {}),
    ...(opts.onProxyFallback !== undefined ? { onProxyFallback: opts.onProxyFallback } : {}),
  });

  fs.mkdirSync(layout.tempDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(layout.tempDir, "core-staged-"));
  const archivePath = path.join(dir, "archive.download");
  const exe = path.join(dir, path.basename(layout.coreExe));
  let staged = false;
  try {
    const available = candidates.filter((name) => assets.some((asset) => asset.name === name));
    if (available.length === 0) {
      throw new Error(
        `No trusted release asset matched ${candidates.join(", ")} for ${MIHOMO_REPO}@${tag}`,
      );
    }
    for (const assetName of available) {
      opts.onStage?.("downloading", tag);
      await downloadReleaseAsset({
        signal: opts.signal,
        repo: MIHOMO_REPO,
        tag,
        assets,
        candidates: [assetName],
        dest: archivePath,
        ...(opts.proxyUri !== undefined ? { proxyUri: opts.proxyUri } : {}),
        onProgress: opts.onProgress,
        onProxyFallback: opts.onProxyFallback,
      });
      opts.onStage?.("extracting", tag);
      await extractCoreArchive(archivePath, assetName, exe, opts.signal);
      opts.signal?.throwIfAborted();
      if (await coreBinaryRuns(exe)) {
        staged = true;
        return { version: tag, exe, dir, assetName, source };
      }
      fs.rmSync(exe, { force: true });
    }
    throw new Error(
      `No published Core build runs on this processor (tried ${available.join(", ")}).`,
    );
  } finally {
    if (!staged) fs.rmSync(dir, { recursive: true, force: true });
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
