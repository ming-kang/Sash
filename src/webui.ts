import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type SashLayout, sashLayout } from "./paths.js";

/**
 * Built-in WebUI asset directory resolution.
 *
 * The dashboard is pre-built via Vite and bundled in dist/ui inside the
 * npm package. Sashd serves it directly at /ui/ with no download step.
 * Custom user dashboards in <root>/ui take precedence if present.
 */
export function resolveUiDir(
  layout: SashLayout = sashLayout(),
  runtimeDir = path.dirname(fileURLToPath(import.meta.url)),
): string | null {
  // 1. Optional user-customized override in <root>/ui
  if (fs.existsSync(path.join(layout.uiDir, "index.html"))) {
    return layout.uiDir;
  }

  // 2. In production (dist/): dist/ui
  const distUi = path.join(runtimeDir, "ui");
  if (fs.existsSync(path.join(distUi, "index.html"))) {
    return distUi;
  }

  // 3. In dev / test (src/): ../dist/ui
  const devUi = path.join(path.dirname(runtimeDir), "dist", "ui");
  if (fs.existsSync(path.join(devUi, "index.html"))) {
    return devUi;
  }

  return null;
}

export function uiInstalled(
  layout: SashLayout = sashLayout(),
  runtimeDir = path.dirname(fileURLToPath(import.meta.url)),
): boolean {
  return resolveUiDir(layout, runtimeDir) !== null;
}
