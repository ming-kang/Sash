import fs from "node:fs";
import path from "node:path";
import { manifestReleaseAssets, readBootstrapManifest } from "./bootstrap-manifest.js";
import { GEODATA_FILE_NAMES } from "./core-config-validation.js";
import {
  downloadReleaseAsset,
  GEODATA_REPO,
  listReleaseAssets,
  type ReleaseAsset,
  resolveLatestTag,
  validateCoreReleaseTag,
} from "./github.js";
import type { ProxyFallbackListener } from "./http.js";
import type { SashLayout } from "./paths.js";

/**
 * Verified geodata pre-seeding. The Core fetches its databases itself and
 * cannot use the proxy it has not started yet, so when every geox-url mirror
 * fails, Sash downloads the missing database through the verified release
 * pipeline (publisher SHA-256 from the release API, or from the packaged
 * bootstrap manifest when the API is unreachable) and drops it into the data
 * folder. The Core then skips the download entirely.
 */

export interface GeodataSeedOptions {
  signal?: AbortSignal;
  /** Route GitHub traffic through this proxy instead of the environment proxy. */
  proxyUri?: string;
  onProxyFallback?: ProxyFallbackListener;
}

export interface GeodataSeedResult {
  file: string;
  /** "pinned" when the digest came from the packaged bootstrap manifest. */
  source: "live" | "pinned";
}

async function resolveGeodataRelease(
  options: GeodataSeedOptions,
): Promise<{ tag: string; assets: ReleaseAsset[]; source: "live" | "pinned" }> {
  try {
    const tag = validateCoreReleaseTag(
      await resolveLatestTag(
        GEODATA_REPO,
        options.signal,
        options.onProxyFallback,
        options.proxyUri,
      ),
    );
    const assets = await listReleaseAssets(
      GEODATA_REPO,
      tag,
      options.signal,
      options.onProxyFallback,
      options.proxyUri,
    );
    return { tag, assets, source: "live" };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    const manifest = readBootstrapManifest();
    if (manifest) {
      return {
        tag: manifest.geodata.tag,
        assets: manifestReleaseAssets(GEODATA_REPO, manifest.geodata),
        source: "pinned",
      };
    }
    throw error;
  }
}

/** Download one known geodata database into the data folder, digest-verified. */
export async function seedGeodataFile(
  file: string,
  layout: SashLayout,
  options: GeodataSeedOptions = {},
): Promise<GeodataSeedResult> {
  if (!(GEODATA_FILE_NAMES as readonly string[]).includes(file)) {
    throw new Error(`internal error: refusing to seed unknown geodata file ${file}`);
  }
  const { tag, assets, source } = await resolveGeodataRelease(options);
  fs.mkdirSync(layout.tempDir, { recursive: true });
  const directory = fs.mkdtempSync(path.join(layout.tempDir, "geodata-download-"));
  const dest = path.join(directory, file);
  try {
    await downloadReleaseAsset({
      signal: options.signal,
      repo: GEODATA_REPO,
      tag,
      assets,
      candidates: [file],
      dest,
      ...(options.proxyUri !== undefined ? { proxyUri: options.proxyUri } : {}),
      onProxyFallback: options.onProxyFallback,
    });
    // Same-volume rename: the file appears in the data folder atomically.
    fs.renameSync(dest, path.join(layout.root, file));
    return { file, source };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
