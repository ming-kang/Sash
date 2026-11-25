import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../error-utils.js";
import {
  downloadReleaseAsset,
  listReleaseAssets,
  parseSha256Digest,
  type ReleaseAsset,
  selectReleaseAsset,
} from "../github.js";
import { currentPackageRoot, readSashPackageInfo } from "../package-info.js";
import type { SashLayout } from "../paths.js";
import { readHelperDigests } from "./helper-digests.js";

/**
 * The Windows TUN helper is the Go service under helper/. It is not part of
 * the npm package: installation takes it from this Sash version's GitHub
 * Release (or a local `npm run build:helper` output in a source checkout).
 */
export const HELPER_REPO = "ming-kang/Sash";

export function helperAssetName(arch: string = process.arch): string {
  return `sash-tun-helper-win32-${arch}.exe`;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export interface HelperSource {
  file: string;
  sha256: string;
  cleanup(): Promise<void>;
}

export interface HelperSourceOptions {
  proxyUri?: string;
  /** Test seam for the source-checkout precedence; production uses the real package. */
  packageRoot?: string;
}

async function downloadHelper(
  layout: SashLayout,
  tag: string,
  asset: ReleaseAsset,
  proxyUri?: string,
): Promise<HelperSource> {
  await fs.mkdir(layout.tempDir, { recursive: true });
  const file = path.join(layout.tempDir, asset.name);
  await downloadReleaseAsset({
    repo: HELPER_REPO,
    tag,
    asset,
    dest: file,
    ...(proxyUri !== undefined ? { proxyUri } : {}),
  });
  return {
    file,
    sha256: parseSha256Digest(asset.digest),
    cleanup: () => fs.rm(file, { force: true }),
  };
}

/**
 * The release API is only a digest oracle: both paths download the same
 * direct URL and verify the bytes after download. When the API cannot be
 * read — rate limit, offline — the digests embedded in this package at build
 * time take over as the oracle; they never skip or weaken verification.
 */
async function fallbackHelperSource(
  layout: SashLayout,
  tag: string,
  name: string,
  version: string,
  cause: unknown,
  proxyUri?: string,
): Promise<HelperSource> {
  const embedded = readHelperDigests()?.find((asset) => asset.name === name);
  if (!embedded) {
    throw new Error(
      `Could not read the Sash ${version} GitHub Release: ${errorMessage(cause)}; ` +
        `this package carries no embedded digest for ${name}, so the verified direct download is unavailable`,
    );
  }
  return downloadHelper(
    layout,
    tag,
    { name: embedded.name, size: embedded.size, digest: `sha256:${embedded.sha256}` },
    proxyUri,
  );
}

export async function resolveHelperSource(
  layout: SashLayout,
  options: HelperSourceOptions = {},
): Promise<HelperSource> {
  const name = helperAssetName();
  const local = path.join(options.packageRoot ?? currentPackageRoot(), "helper", "bin", name);
  if ((await fs.stat(local).catch(() => undefined))?.isFile())
    return { file: local, sha256: await sha256File(local), cleanup: async () => {} };

  const { version } = readSashPackageInfo();
  const tag = `v${version}`;
  let assets: Awaited<ReturnType<typeof listReleaseAssets>>;
  try {
    assets = await listReleaseAssets(HELPER_REPO, tag, undefined, undefined, options.proxyUri);
  } catch (error) {
    return fallbackHelperSource(layout, tag, name, version, error, options.proxyUri);
  }
  const asset = selectReleaseAsset(assets, [name]);
  if (!asset) throw new Error(`The Sash ${version} GitHub Release has no ${name}`);
  return downloadHelper(layout, tag, asset, options.proxyUri);
}
