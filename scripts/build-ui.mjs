import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");

execFileSync(process.execPath, [viteBin, "build", "--config", "web/vite.config.ts"], {
  cwd: root,
  stdio: "inherit",
});

console.log("[build-ui] WebUI built successfully via Vite to dist/ui/");
