import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReleaseAsset } from "./github.js";
import { validateCoreReleaseTag } from "./github.js";

/**
 * Packaged bootstrap metadata: the pinned Core and geodata releases recorded
 * when this Sash package was built (see scripts/build-bootstrap-manifest.mjs).
 *
 * The manifest is the SHA-256 trust anchor when the live release API is
 * unreachable and no mirror download can be accepted; it travels inside the
 * npm package, whose integrity npm itself guarantees.
 *
 * The file is absent from development checkouts, so every read is lenient:
 * a missing or malformed manifest simply means "no offline fallback".
 */

export interface BootstrapAsset {
  name: string;
  size: number;
  sha256: string;
}

export interface BootstrapRelease {
  tag: string;
  assets: BootstrapAsset[];
}

export interface BootstrapManifest {
  core: BootstrapRelease;
  geodata: BootstrapRelease;
}

export function defaultBootstrapManifestPath(): string {
  // Bundled entries live flat in dist/; the CLI and daemon bundle resolve the same path.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "bootstrap-manifest.json");
}

export function bootstrapManifestPath(): string {
  const override = process.env.SASH_BOOTSTRAP_MANIFEST?.trim();
  return override && path.isAbsolute(override) ? override : defaultBootstrapManifestPath();
}

function parseAsset(value: unknown): BootstrapAsset | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const asset = value as Record<string, unknown>;
  if (
    typeof asset.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(asset.name) ||
    typeof asset.size !== "number" ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    typeof asset.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(asset.sha256)
  ) {
    return undefined;
  }
  return { name: asset.name, size: asset.size, sha256: asset.sha256 };
}

function parseRelease(value: unknown): BootstrapRelease | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const release = value as Record<string, unknown>;
  if (typeof release.tag !== "string" || !Array.isArray(release.assets)) return undefined;
  let tag: string;
  try {
    tag = validateCoreReleaseTag(release.tag);
  } catch {
    return undefined;
  }
  const assets = release.assets.flatMap((entry) => {
    const asset = parseAsset(entry);
    return asset ? [asset] : [];
  });
  return assets.length > 0 ? { tag, assets } : undefined;
}

/** Strict shape validation wrapped in the lenient-read contract. */
export function parseBootstrapManifest(value: unknown): BootstrapManifest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const manifest = value as Record<string, unknown>;
  const core = parseRelease(manifest.core);
  const geodata = parseRelease(manifest.geodata);
  return core && geodata ? { core, geodata } : undefined;
}

interface CachedManifest {
  mtimeMs: number;
  size: number;
  manifest: BootstrapManifest | undefined;
}

const manifestCache = new Map<string, CachedManifest>();

export function manifestReleaseAssets(repo: string, release: BootstrapRelease): ReleaseAsset[] {
  return release.assets.map((asset) => ({
    name: asset.name,
    browser_download_url: `https://github.com/${repo}/releases/download/${release.tag}/${asset.name}`,
    size: asset.size,
    digest: `sha256:${asset.sha256}`,
  }));
}

/** Best-effort read; an unreadable manifest means "no offline fallback". */
export function readBootstrapManifest(
  file: string = bootstrapManifestPath(),
): BootstrapManifest | undefined {
  const filePath = path.resolve(file);
  try {
    const stat = fs.statSync(filePath);
    const cached = manifestCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.manifest;
    }
    const manifest = parseBootstrapManifest(JSON.parse(fs.readFileSync(filePath, "utf8")));
    manifestCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, manifest });
    return manifest;
  } catch {
    manifestCache.delete(filePath);
    return undefined;
  }
}
