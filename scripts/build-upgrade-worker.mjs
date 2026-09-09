import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "dist");
await build({
  configFile: false,
  publicDir: false,
  ssr: { noExternal: true },
  build: {
    ssr: path.join(root, "src", "upgrade-worker-entry.ts"),
    outDir,
    emptyOutDir: false,
    target: "node24",
    minify: false,
    license: { fileName: "upgrade-worker.LICENSE.md" },
    emitAssets: true,
    rolldownOptions: {
      output: {
        format: "es",
        entryFileNames: "upgrade-worker.mjs",
        codeSplitting: false,
        banner:
          'import { createRequire as __sashCreateRequire } from "node:module"; const require = __sashCreateRequire(import.meta.url);',
      },
    },
  },
});
const notices = fs.readFileSync(path.join(outDir, "upgrade-worker.LICENSE.md"), "utf8");
fs.appendFileSync(
  path.join(outDir, "upgrade-worker.mjs"),
  `\n/*\n${notices.replaceAll("*/", "* /")}\n*/\n`,
);

import fs from "node:fs";
