import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreCandidates, GEODATA_FILES } from "./bootstrap-manifest-data.mjs";
import {
  helperAssets,
  helperTargets,
  pairedCoreAsset,
  pairedCoreFilename,
} from "./helper-artifacts.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outFile = path.join(root, "dist", "bootstrap-manifest.json");
const buildHelpers = process.argv.includes("--build-helpers");

const MIHOMO_REPO = "MetaCubeX/mihomo";
const GEODATA_REPO = "MetaCubeX/meta-rules-dat";

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
  helpers: { assets: [], cores: [] },
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
if (buildHelpers) {
  const targets = helperTargets();
  if (targets.length > 0) {
    const { extractCoreArchive, mihomoAssetCandidates, validateCoreReleaseTag } = await import(
      "../src/core.ts"
    );
    const { downloadReleaseAsset } = await import("../src/github.ts");
    const tag = validateCoreReleaseTag(manifest.core.tag);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sash-helper-core-"));
    try {
      for (const { platform, arch } of targets) {
        const name = mihomoAssetCandidates(tag, platform, arch).at(-1);
        const asset = coreAssets.find((entry) => entry.name === name);
        if (!asset) throw new Error(`Missing paired Core asset: ${name}`);
        const archive = path.join(tmp, "archive");
        const dist = path.dirname(outFile);
        const exe = path.join(dist, pairedCoreFilename(platform, arch));
        await downloadReleaseAsset({
          repo: MIHOMO_REPO,
          tag,
          asset: { ...asset, digest: `sha256:${asset.sha256}` },
          dest: archive,
        });
        await extractCoreArchive(archive, asset.name, exe);
        manifest.helpers.cores.push(await pairedCoreAsset(dist, platform, arch));
        fs.unlinkSync(archive);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const result = spawnSync(process.execPath, ["scripts/build-helper.mjs", "--all"], {
    cwd: root,
    env: { ...process.env, SASH_REQUIRE_HELPER_BOOTSTRAP: "1" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Release helper build failed");
}

manifest.helpers.assets = await helperAssets(root);
fs.writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `[build-bootstrap-manifest] pinned Core ${manifest.core.tag} (${coreAssets.length} assets), geodata ${manifest.geodata.tag} (${geodataAssets.length} files), and ${manifest.helpers.assets.length} packaged helpers`,
);
