// Hashes the exact TUN helper executables the CI tun-helper job uploaded as
// its artifact — the same bytes the GitHub Release later carries — and writes
// them into the npm package as dist/tun-helper-digests.json. The packaged
// digests are the SHA-256 trust anchor for the direct-download fallback when
// the GitHub API is unreachable (see src/tun-platform/helper-source.ts).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HELPER_ARCHITECTURES, helperAssetFileName } from "./helper-data.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const exeDir = process.argv[2] ? path.resolve(process.argv[2]) : "";
if (!exeDir || process.argv.length < 3 || process.argv.length > 4) {
  console.error(
    "Usage: node scripts/build-helper-digests.mjs <directory with the helper exes> [output file]",
  );
  process.exit(1);
}
const outFile = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(root, "dist", "tun-helper-digests.json");

const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const assets = [];
for (const arch of Object.keys(HELPER_ARCHITECTURES)) {
  const name = helperAssetFileName(arch);
  const file = path.join(exeDir, name);
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    console.error(`[build-helper-digests] the helper artifact is missing ${name}`);
    process.exit(1);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assets.push({ name, size: bytes.length, sha256 });
  console.log(`[build-helper-digests] ${name} (${bytes.length} bytes, ${sha256})`);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify({ version, assets }, null, 2)}\n`);
console.log(`[build-helper-digests] pinned ${assets.length} helper digests for ${version}`);
