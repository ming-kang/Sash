import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Records the current upstream Core and geodata releases as the package's
 * bootstrap manifest (dist/bootstrap-manifest.json). The manifest is the
 * offline trust anchor: when a user's network cannot reach the GitHub release
 * API, Sash still verifies mirror downloads against these publisher digests.
 *
 * Runs in CI between `npm run build` and `npm pack`; it needs network access
 * to api.github.com and honors GITHUB_TOKEN for the rate limit. Pin the Core
 * release with SASH_BOOTSTRAP_CORE_TAG when a specific one is wanted.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outFile = path.join(root, "dist", "bootstrap-manifest.json");

const MIHOMO_REPO = "MetaCubeX/mihomo";
const GEODATA_REPO = "MetaCubeX/meta-rules-dat";

/** Keep in sync with src/core-config-validation.ts GEODATA_FILE_NAMES. */
const GEODATA_FILES = [
  "geoip.dat",
  "geoip.metadb",
  "geosite.dat",
  "country.mmdb",
  "GeoLite2-ASN.mmdb",
];

/** Keep in sync with src/core.ts mihomoAssetCandidates across every platform. */
function coreCandidates(tag) {
  const names = [];
  for (const os of ["windows", "linux", "darwin"]) {
    const ext = os === "windows" ? "zip" : "gz";
    for (const variant of ["v3", "", "v2", "v1", "compatible"]) {
      names.push(`mihomo-${os}-amd64-${variant ? `${variant}-` : ""}${tag}.${ext}`);
    }
    names.push(`mihomo-${os}-arm64-${tag}.${ext}`);
  }
  return names;
}

async function fetchRelease(repo, tag) {
  const url = tag
    ? `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "sash-bootstrap-manifest",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw lastError;
}

function pickAssets(release, wantedNames, repo) {
  const byName = new Map();
  for (const asset of release.assets ?? []) {
    if (typeof asset?.name === "string" && !byName.has(asset.name)) byName.set(asset.name, asset);
  }
  const picked = [];
  for (const name of wantedNames) {
    const asset = byName.get(name);
    if (!asset) continue;
    const match =
      typeof asset.digest === "string" && asset.digest.match(/^sha256:([0-9a-f]{64})$/i);
    if (!match || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`Release asset ${name} of ${repo} lacks a usable SHA-256 digest or size`);
    }
    picked.push({ name, size: asset.size, sha256: match[1].toLowerCase() });
  }
  return picked;
}

const coreTag = process.env.SASH_BOOTSTRAP_CORE_TAG?.trim() || undefined;
const coreRelease = await fetchRelease(MIHOMO_REPO, coreTag);
if (typeof coreRelease.tag_name !== "string" || !coreRelease.tag_name) {
  throw new Error(`Release response for ${MIHOMO_REPO} is missing tag_name`);
}
const coreAssets = pickAssets(coreRelease, coreCandidates(coreRelease.tag_name), MIHOMO_REPO);
// Every supported platform needs at least one runnable candidate in the manifest.
for (const os of ["windows", "linux", "darwin"]) {
  for (const arch of ["amd64", "arm64"]) {
    if (!coreAssets.some((asset) => asset.name.startsWith(`mihomo-${os}-${arch}`))) {
      throw new Error(`Release ${coreRelease.tag_name} has no ${os}/${arch} Core asset to pin`);
    }
  }
}

const geodataRelease = await fetchRelease(GEODATA_REPO);
if (typeof geodataRelease.tag_name !== "string" || !geodataRelease.tag_name) {
  throw new Error(`Release response for ${GEODATA_REPO} is missing tag_name`);
}
const geodataAssets = pickAssets(geodataRelease, GEODATA_FILES, GEODATA_REPO);
const missingGeodata = GEODATA_FILES.filter(
  (name) => !geodataAssets.some((asset) => asset.name === name),
);
if (missingGeodata.length > 0) {
  throw new Error(
    `Release ${geodataRelease.tag_name} is missing geodata: ${missingGeodata.join(", ")}`,
  );
}

const manifest = {
  core: { tag: coreRelease.tag_name, assets: coreAssets },
  geodata: { tag: geodataRelease.tag_name, assets: geodataAssets },
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `[build-bootstrap-manifest] pinned Core ${manifest.core.tag} (${coreAssets.length} assets) and geodata ${manifest.geodata.tag} (${geodataAssets.length} files)`,
);
