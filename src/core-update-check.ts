import { currentCoreVersion, resolveCoreRelease } from "./core.js";
import { parseSha256Digest, RELEASE_ASSET_SIZE_LIMIT, selectReleaseAsset } from "./github.js";
import type { SashLayout } from "./paths.js";

export interface CoreUpdateCheck {
  current: string | null;
  target: string;
  available: boolean;
  asset: string;
}

/** Read release metadata only; checking never starts management or downloads an archive. */
export async function checkCoreUpdate(
  layout: SashLayout,
  version?: string,
  signal?: AbortSignal,
): Promise<CoreUpdateCheck> {
  const current = currentCoreVersion(layout) || null;
  const { tag, assets, candidates } = await resolveCoreRelease({
    ...(version !== undefined ? { tag: version } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  const asset = selectReleaseAsset(assets, candidates);
  if (!asset)
    throw new Error(
      `No compatible Core artifact is available for ${process.platform}/${process.arch} at ${tag}`,
    );
  if (asset.size > RELEASE_ASSET_SIZE_LIMIT)
    throw new Error("Core release exceeds the download size limit");
  parseSha256Digest(asset.digest);
  return { current, target: tag, available: current !== tag, asset: asset.name };
}
