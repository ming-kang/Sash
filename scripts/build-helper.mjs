// Builds the Windows TUN helper (helper/) for every Windows architecture.
// The binaries never enter the npm package: CI attaches them to the GitHub
// Release, and a source checkout uses the default output directory directly.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ARCHITECTURES = { x64: "amd64", arm64: "arm64" };

const args = process.argv.slice(2);
let outDir = path.join(root, "helper", "bin");
if (args[0] === "--out" && args[1] && args.length === 2) outDir = path.resolve(args[1]);
else if (args.length > 0) {
  console.error("Usage: npm run build:helper [-- --out <dir>]");
  process.exit(args[0] === "--help" ? 0 : 1);
}

const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
fs.mkdirSync(outDir, { recursive: true });
for (const [arch, goarch] of Object.entries(ARCHITECTURES)) {
  const outfile = path.join(outDir, `sash-tun-helper-win32-${arch}.exe`);
  const result = spawnSync(
    "go",
    ["build", "-trimpath", "-ldflags", `-s -w -X main.buildVersion=${version}`, "-o", outfile, "."],
    {
      cwd: path.join(root, "helper"),
      env: { ...process.env, CGO_ENABLED: "0", GOOS: "windows", GOARCH: goarch },
      stdio: "inherit",
    },
  );
  if (result.error) {
    console.error(`[build-helper] Could not run Go: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[build-helper] Go failed to build windows/${goarch}`);
    process.exit(1);
  }
  const bytes = fs.readFileSync(outfile);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  console.log(`[build-helper] ${path.relative(root, outfile)} (${bytes.length} bytes, ${sha256})`);
}
