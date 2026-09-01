import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await build({ configFile: path.join(root, "web", "vite.config.ts") });
console.log("[build-ui] WebUI built successfully via Vite to dist/ui/");
