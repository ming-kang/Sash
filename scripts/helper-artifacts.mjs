import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

export const helperPlatforms = ["darwin", "linux", "win32"];
export const helperArchitectures = ["x64", "arm64"];

export function helperFilename(platform, arch) {
  return `sash-helper-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
}

export function pairedCoreFilename(platform, arch) {
  return `sash-tun-core-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
}

export const helperFilenames = helperPlatforms.flatMap((platform) =>
  helperArchitectures.map((arch) => helperFilename(platform, arch)),
);

/** The Go helper in helper/ builds for every supported platform target. */
export function helperTargets(_root = ".") {
  return helperPlatforms.flatMap((platform) =>
    helperArchitectures.map((arch) => ({ platform, arch })),
  );
}

async function describeAsset(dist, name, platform, arch) {
  const file = path.join(dist, name);
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) throw new Error(`Invalid helper artifact: ${file}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { name, platform, arch, size: info.size, sha256: hash.digest("hex") };
}

export function helperAsset(dist, platform, arch) {
  return describeAsset(dist, helperFilename(platform, arch), platform, arch);
}

export function pairedCoreAsset(dist, platform, arch) {
  return describeAsset(dist, pairedCoreFilename(platform, arch), platform, arch);
}

export async function helperAssets(root) {
  const dist = path.join(root, "dist");
  const assets = [];
  for (const { platform, arch } of helperTargets()) {
    assets.push(await helperAsset(dist, platform, arch));
  }
  return assets;
}
