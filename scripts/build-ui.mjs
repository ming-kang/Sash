import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const webDir = path.join(root, "web");
const outDir = path.join(root, "dist", "ui");

fs.mkdirSync(outDir, { recursive: true });

const tscBin = path.join(root, "node_modules", "typescript", "bin", "tsc");

// 1. Compile TypeScript modules
execFileSync(process.execPath, [tscBin, "-p", path.join(webDir, "tsconfig.json")], {
  cwd: root,
  stdio: "inherit",
});

// 2. Copy static HTML & CSS assets
fs.copyFileSync(path.join(webDir, "index.html"), path.join(outDir, "index.html"));
fs.copyFileSync(path.join(webDir, "styles.css"), path.join(outDir, "styles.css"));

console.log("[build-ui] WebUI built successfully to dist/ui/");
