import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  helperArchitectures,
  helperAsset,
  helperFilename,
  helperPlatforms,
  pairedCoreFilename,
} from "./helper-artifacts.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const [platform = process.platform, arch = process.arch] = args;
const all = args[0] === "--all" && args.length === 1;
if (
  args[0] === "--help" ||
  (!all &&
    (args.length > 2 ||
      args[0]?.startsWith("-") ||
      !helperPlatforms.includes(platform) ||
      !helperArchitectures.includes(arch)))
) {
  console.error("Usage: npm run build:helper -- [--all | [darwin|linux|win32] [x64|arm64]]");
  process.exit(args[0] === "--help" ? 0 : 1);
}

function build(targetPlatform, targetArch) {
  const outfile = path.join(root, "dist", helperFilename(targetPlatform, targetArch));
  const goos = targetPlatform === "win32" ? "windows" : targetPlatform;
  const goarch = targetArch === "x64" ? "amd64" : targetArch;
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const manifestFile = path.join(root, "dist", "bootstrap-manifest.json");
  const manifest = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
    : undefined;
  const core = manifest?.helpers?.cores?.find(
    ({ name }) => name === pairedCoreFilename(targetPlatform, targetArch),
  );
  const digest = core?.sha256;
  if (core && !/^[0-9a-f]{64}$/.test(digest))
    throw new Error(`Invalid paired Core digest: ${core.name}`);
  if (!digest && process.env.SASH_REQUIRE_HELPER_BOOTSTRAP === "1")
    throw new Error(`No paired Core digest for ${targetPlatform}/${targetArch}`);
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  const result = spawnSync(
    "go",
    [
      "build",
      "-trimpath",
      "-ldflags",
      `-s -w -X main.buildVersion=${version} -X main.coreSHA256=${digest ?? ""}`,
      "-o",
      outfile,
      ".",
    ],
    {
      cwd: path.join(root, "helper"),
      env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
      stdio: "inherit",
    },
  );
  if (result.error) throw new Error(`Could not run Go: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Go failed to build ${targetPlatform}/${targetArch}`);
  const stat = fs.statSync(outfile);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Invalid helper output: ${outfile}`);
  console.log(`Wrote ${outfile}`);
}

try {
  const targets = all
    ? helperPlatforms.flatMap((platform) => helperArchitectures.map((arch) => ({ platform, arch })))
    : [{ platform, arch }];
  const dist = path.join(root, "dist");
  for (const { platform, arch } of targets) build(platform, arch);
  const assets = await Promise.all(
    targets.map(({ platform, arch }) => helperAsset(dist, platform, arch)),
  );
  // The daemon's trust anchor is bootstrap-manifest.json — pin the helper
  // digests there so install/uninstall checks accept the built binaries.
  const manifestFile = path.join(dist, "bootstrap-manifest.json");
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    manifest.helpers ??= {};
    manifest.helpers.assets ??= [];
    const packaged = manifest.helpers.assets;
    for (const asset of assets) {
      const entry = packaged.find((item) => item.name === asset.name);
      if (entry) {
        Object.assign(entry, { size: asset.size, sha256: asset.sha256 });
      } else {
        packaged.push(asset);
      }
    }
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  for (const { name, size, sha256 } of assets)
    console.log(`Wrote dist/${name} (${size} bytes, ${sha256})`);
} catch (error) {
  console.error(`[build-helper] ${error.message}`);
  process.exit(1);
}
