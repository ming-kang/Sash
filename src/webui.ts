import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The dashboard always comes from the running package, so upgrading Sash
 * replaces it; nothing in the data folder can pin an older copy.
 */
export function resolveUiDir(
  runtimeDir = path.dirname(fileURLToPath(import.meta.url)),
): string | null {
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

export function uiInstalled(runtimeDir = path.dirname(fileURLToPath(import.meta.url))): boolean {
  return resolveUiDir(runtimeDir) !== null;
}
