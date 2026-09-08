#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
register({ tsconfig: path.join(root, "tsconfig.json") });
await import("../src/node-version-guard.js");

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "build") {
    if (args.length !== 1) throw new Error("Usage: sash-dev build");
    await import("./build-ui.mjs");
    return;
  }

  const { sashRoot } = await import("../src/paths.js");
  // Only this child process receives the development home. Ignore a parent
  // shell's SASH_HOME so ordinary sash commands keep their own runtime.
  delete process.env.SASH_HOME;
  const regularHome = sashRoot();
  const devHome = process.env.SASH_DEV_HOME?.trim() || `${regularHome}-dev`;
  if (!path.isAbsolute(devHome)) throw new Error("SASH_DEV_HOME must be an absolute path");
  const canonical = (value) => {
    const absolute = fs.existsSync(value) ? fs.realpathSync(value) : path.resolve(value);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  if (canonical(devHome) === canonical(regularHome)) {
    throw new Error("SASH_DEV_HOME must differ from the regular Sash data directory");
  }
  process.env.SASH_HOME = devHome;
  process.env.SASH_DEVELOPMENT = "1";

  if (
    ["start", "restart", "web"].includes(args[0]) &&
    !fs.existsSync(path.join(root, "dist", "ui", "index.html"))
  ) {
    await import("./build-ui.mjs");
  }
  process.argv = [process.execPath, path.join(root, "src", "cli.ts"), ...args];
  await import("../src/cli.js");
  if (args.some((arg) => ["help", "--help", "-h"].includes(arg))) {
    console.log(`\nDevelopment source: ${root}\nDevelopment data:   ${devHome}`);
    console.log("  sash-dev build    rebuild the WebUI after frontend changes");
    console.log("  sash-dev stop     stop the daemon before loading backend changes");
    console.log("  sash-dev web      start the management UI without starting Core");
  }
}

try {
  await main();
} catch (error) {
  console.error(`[sash-dev] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
