import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type SashLayout, sashLayout } from "./paths.js";

/** A user dashboard in the data folder overrides the one bundled in dist/. */
export function resolveUiDir(
  layout: SashLayout = sashLayout(),
  runtimeDir = path.dirname(fileURLToPath(import.meta.url)),
): string | null {
  if (fs.existsSync(path.join(layout.uiDir, "index.html"))) {
    return layout.uiDir;
  }

  const distUi = path.join(runtimeDir, "ui");
  if (fs.existsSync(path.join(distUi, "index.html"))) {
    return distUi;
  }

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
