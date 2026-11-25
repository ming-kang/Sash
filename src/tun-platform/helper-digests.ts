import fs from "node:fs";
import path from "node:path";
import { currentPackageRoot } from "../package-info.js";

/**
 * Packaged TUN helper metadata: the SHA-256 digests of the exact helper
 * executables this Sash version's GitHub Release carries, recorded from the
 * release artifact when this package was built (see
 * scripts/build-helper-digests.mjs).
 *
 * The digests are the trust anchor for the direct-download fallback when the
 * release API is unreachable; they travel inside the npm package, whose
 * integrity npm itself guarantees — installing a package means already
 * trusting it to run the installer.
 *
 * The file is absent from development checkouts, so every read is lenient:
 * a missing or malformed file simply means "no offline fallback".
 */

export interface HelperDigestAsset {
  name: string;
  size: number;
  sha256: string;
}

export function helperDigestsPath(): string {
  const override = process.env.SASH_TUN_HELPER_DIGESTS?.trim();
  return override && path.isAbsolute(override)
    ? override
    : path.join(currentPackageRoot(), "dist", "tun-helper-digests.json");
}

function parseAsset(value: unknown): HelperDigestAsset | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const asset = value as Record<string, unknown>;
  if (
    typeof asset.name !== "string" ||
    !/^sash-tun-helper-win32-[A-Za-z0-9]+\.exe$/.test(asset.name) ||
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

export function parseHelperDigests(value: unknown): HelperDigestAsset[] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const digests = value as Record<string, unknown>;
  if (!Array.isArray(digests.assets)) return undefined;
  const assets = digests.assets.flatMap((entry) => {
    const asset = parseAsset(entry);
    return asset ? [asset] : [];
  });
  return assets.length > 0 ? assets : undefined;
}

export function readHelperDigests(
  file: string = helperDigestsPath(),
): HelperDigestAsset[] | undefined {
  try {
    return parseHelperDigests(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}
