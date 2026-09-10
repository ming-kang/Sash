import { currentCoreVersion, mihomoAssetCandidates } from "./core.js";
import { validateCoreReleaseTag } from "./core-install-record.js";
import { detectAmd64Level } from "./cpu-features.js";
import {
  listReleaseAssets,
  MIHOMO_REPO,
  parseSha256Digest,
  RELEASE_ASSET_SIZE_LIMIT,
  resolveLatestTag,
  selectReleaseAsset,
} from "./github.js";
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
  const target = validateCoreReleaseTag(version ?? (await resolveLatestTag(MIHOMO_REPO, signal)));
  const [assets, level] = await Promise.all([
    listReleaseAssets(MIHOMO_REPO, target, signal),
    detectAmd64Level(),
  ]);
  const asset = selectReleaseAsset(
    assets,
    mihomoAssetCandidates(target, process.platform, process.arch, level),
  );
  if (!asset)
    throw new Error(
      `No compatible Core artifact is available for ${process.platform}/${process.arch} at ${target}`,
    );
  if (asset.size > RELEASE_ASSET_SIZE_LIMIT)
    throw new Error("Core release exceeds the download size limit");
  parseSha256Digest(asset.digest);
  return { current, target, available: current !== target, asset: asset.name };
}
