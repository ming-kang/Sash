import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findTestFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return findTestFiles(file);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [file] : [];
  });
}

const testRoots = [
  fileURLToPath(new URL("../src", import.meta.url)),
  fileURLToPath(new URL("../web/src", import.meta.url)),
];
const testFiles = testRoots.flatMap(findTestFiles).sort();

const filters = process.argv.slice(2);
const selected = filters.length
  ? testFiles.filter((file) => filters.some((needle) => file.includes(needle)))
  : testFiles;

if (selected.length === 0) {
  console.error(`No test files match: ${filters.join(", ")}`);
  process.exit(1);
}

const noProxyEntries = [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1", "localhost", "::1"]
  .filter(Boolean)
  .flatMap((value) => value.split(","))
  .map((value) => value.trim())
  .filter(Boolean);
const noProxy = [...new Set(noProxyEntries)].join(",");

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...selected], {
  stdio: "inherit",
  // Local fixtures must never be sent through a developer's configured proxy
  // (which may itself be a running Sash/Core instance).
  env: { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy },
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
