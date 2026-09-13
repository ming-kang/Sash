import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "dist");

const REQUIRE_BANNER =
  'import { createRequire as __sashCreateRequire } from "node:module"; const require = __sashCreateRequire(import.meta.url);';

// One self-contained bundle per process entry, loaded through a thin launcher
// (see below). webui/sash-installation are bundled as standalone modules
// because package-smoke imports them directly.
// Rolldown preserves the source shebang itself; do not add one via banner.
const entries = [
  { source: "src/cli.ts", output: "cli.bundle.js", launcher: "cli.js" },
  { source: "src/daemon/entry.ts", output: "daemon-entry.bundle.js", launcher: "daemon-entry.js" },
  {
    source: "src/autostart/entry.ts",
    output: "autostart-entry.bundle.js",
    launcher: "autostart-entry.js",
  },
  { source: "src/webui.ts", output: "webui.js" },
  { source: "src/sash-installation.ts", output: "sash-installation.js" },
];

for (const entry of entries) {
  const licenseFile = `${entry.output.replace(/\.js$/, "")}.LICENSE.md`;
  await build({
    configFile: false,
    publicDir: false,
    logLevel: "warn",
    ssr: { noExternal: true },
    build: {
      ssr: path.join(root, entry.source),
      outDir,
      emptyOutDir: false,
      target: "node24",
      minify: false,
      reportCompressedSize: false,
      license: { fileName: licenseFile },
      emitAssets: true,
      rolldownOptions: {
        output: {
          format: "es",
          entryFileNames: entry.output,
          codeSplitting: false,
          banner: REQUIRE_BANNER,
        },
      },
    },
  });
  const licensePath = path.join(outDir, licenseFile);
  if (fs.existsSync(licensePath)) {
    const notices = fs.readFileSync(licensePath, "utf8");
    fs.appendFileSync(
      path.join(outDir, entry.output),
      `\n/*\n${notices.replaceAll("*/", "* /")}\n*/\n`,
    );
  }
}

// A bundle cannot enable the V8 compile cache for itself: the module graph
// compiles before any module body runs. The launcher keeps the public entry
// name (bin target, spawn paths) and enables the cache before loading the
// bundle, so repeated CLI invocations skip recompiling it. Best-effort: a
// cache failure must never block startup.
for (const entry of entries) {
  if (!entry.launcher) continue;
  const launcher = `#!/usr/bin/env node
import { enableCompileCache } from "node:module";
try {
  enableCompileCache();
} catch {
  // The compile cache is an optimization; the CLI must start without it.
}
await import("./${entry.output}");
`;
  fs.writeFileSync(path.join(outDir, entry.launcher), launcher);
}
console.log(`[build-dist] bundled ${entries.length} entries into ${outDir}`);
