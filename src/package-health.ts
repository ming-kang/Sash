import fs from "node:fs";
import path from "node:path";
import { readBoundedFile, readBoundedJsonFile } from "./bounded-file.js";
import { isPlainObject } from "./json-shape.js";
import { currentPackageRoot, readSashPackageInfo, UPGRADE_PROTOCOL } from "./package-info.js";

/** Executed through the candidate's own modules before any running instance is stopped. */
export function packageRuntimeHealth(root = currentPackageRoot()) {
  const info = readSashPackageInfo(root);
  if (info.upgradeProtocol !== UPGRADE_PROTOCOL)
    throw new Error("Sash package and runtime upgrade protocols differ");
  for (const entry of [
    "cli.js",
    "daemon-entry.js",
    "autostart-entry.js",
    "autostart-upgrade-entry.js",
    "upgrade-probe-entry.js",
    "upgrade-worker.mjs",
    "upgrade-worker.LICENSE.md",
  ]) {
    const stat = fs.lstatSync(path.join(root, "dist", entry));
    if (!stat.isFile() || stat.size === 0) throw new Error(`Missing Sash entry: ${entry}`);
  }
  const html = readBoundedFile(path.join(root, "dist", "ui", "index.html"), 1024 * 1024).toString(
    "utf8",
  );
  const assets = [...html.matchAll(/(?:src|href)=["']\.\/assets\/([^"']+)["']/g)].map(
    (match) => match[1],
  );
  if (
    !assets.some((asset) => asset?.endsWith(".js")) ||
    !assets.some((asset) => asset?.endsWith(".css"))
  )
    throw new Error("Sash dashboard assets are incomplete");
  for (const asset of assets) {
    if (
      !asset ||
      path.isAbsolute(asset) ||
      asset.includes("\\") ||
      asset.split("/").some((part) => part === ".." || part === "." || part === "")
    )
      throw new Error("Invalid Sash dashboard asset reference");
    const stat = fs.lstatSync(path.join(root, "dist", "ui", "assets", asset));
    if (!stat.isFile() || !stat.size) throw new Error("Sash dashboard asset is empty or missing");
  }
  const ui = path.join(root, "dist", "ui");
  const manifest = readBoundedJsonFile(path.join(ui, ".vite", "manifest.json"), 1024 * 1024);
  if (!isPlainObject(manifest) || Object.keys(manifest).length === 0)
    throw new Error("Sash dashboard build manifest is missing");
  for (const chunk of Object.values(manifest)) {
    if (!isPlainObject(chunk) || typeof chunk.file !== "string")
      throw new Error("Invalid Sash dashboard build manifest");
    const files: string[] = [chunk.file];
    for (const key of ["css", "assets", "imports", "dynamicImports"]) {
      const references = chunk[key];
      if (references === undefined) continue;
      if (
        !Array.isArray(references) ||
        references.some((file: unknown) => typeof file !== "string")
      )
        throw new Error("Invalid Sash dashboard references");
      for (const reference of references as string[]) {
        if (key === "imports" || key === "dynamicImports") {
          if (!Object.hasOwn(manifest, reference))
            throw new Error("Sash dashboard references a missing chunk");
        } else files.push(reference);
      }
    }
    for (const file of files) {
      if (path.isAbsolute(file) || file.includes("\\") || file.split("/").includes(".."))
        throw new Error("Sash dashboard asset escapes its directory");
      const stat = fs.lstatSync(path.join(ui, file));
      if (!stat.isFile() || stat.size === 0) throw new Error("Sash dashboard build is incomplete");
    }
  }
  return {
    name: info.name,
    version: info.version,
    upgradeProtocol: UPGRADE_PROTOCOL,
    node: process.version,
    ui: true,
  };
}
