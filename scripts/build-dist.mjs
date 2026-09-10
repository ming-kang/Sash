import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "dist");

const REQUIRE_BANNER =
  'import { createRequire as __sashCreateRequire } from "node:module"; const require = __sashCreateRequire(import.meta.url);';

// One self-contained single-file bundle per process entry. webui/installation
// are bundled as standalone modules because package-smoke imports them directly.
// Rolldown preserves the source shebang itself; do not add one via banner.
const entries = [
  { source: "src/cli.ts", output: "cli.js" },
  { source: "src/daemon-entry.ts", output: "daemon-entry.js" },
  { source: "src/autostart-entry.ts", output: "autostart-entry.js" },
  { source: "src/autostart-upgrade-entry.ts", output: "autostart-upgrade-entry.js" },
  { source: "src/upgrade-probe-entry.ts", output: "upgrade-probe-entry.js" },
  { source: "src/webui.ts", output: "webui.js" },
  { source: "src/installation.ts", output: "installation.js" },
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
console.log(`[build-dist] bundled ${entries.length} entries into ${outDir}`);
