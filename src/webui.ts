import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import {
  downloadReleaseAsset,
  listReleaseAssets,
  METACUBEXD_REPO,
  resolveLatestTag,
} from "./github.js";
import { type SashLayout, sashLayout } from "./paths.js";

/**
 * MetaCubeXD dashboard acquisition. The upstream release publishes a
 * pre-built `compressed-dist.tgz`; we unpack it into <root>/ui which mihomo
 * serves via its `external-ui` directive — no extra port or process needed.
 */

export function uiInstalled(layout: SashLayout = sashLayout()): boolean {
  return fs.existsSync(path.join(layout.uiDir, "index.html"));
}

export interface UiInstallOptions {
  layout?: SashLayout;
  tag?: string;
  onProgress?: (downloaded: number, total: number | undefined) => void;
}

export async function installWebUi(opts: UiInstallOptions = {}): Promise<string> {
  const layout = opts.layout ?? sashLayout();
  const tag = opts.tag ?? (await resolveLatestTag(METACUBEXD_REPO));
  const assets = await listReleaseAssets(METACUBEXD_REPO, tag).catch(() => []);

  fs.mkdirSync(layout.tempDir, { recursive: true });
  const archivePath = path.join(layout.tempDir, `metacubexd-${tag}.tgz`);
  try {
    await downloadReleaseAsset({
      repo: METACUBEXD_REPO,
      tag,
      assets,
      candidates: ["compressed-dist.tgz"],
      dest: archivePath,
      onProgress: opts.onProgress,
    });

    const staging = path.join(layout.tempDir, `ui-${process.pid}`);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    await tar.x({
      file: archivePath,
      cwd: staging,
      // Strip symlink entries outright: the dashboard is plain static files.
      filter: (entryPath) => !entryPath.includes(".."),
    });

    // The tarball may nest everything under a single top-level directory.
    const root = flattenSingleDir(staging);
    if (!fs.existsSync(path.join(root, "index.html"))) {
      throw new Error("MetaCubeXD archive does not contain index.html at its root");
    }
    fs.rmSync(layout.uiDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(layout.uiDir), { recursive: true });
    fs.renameSync(root, layout.uiDir);
    fs.rmSync(staging, { recursive: true, force: true });
    return tag;
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

function flattenSingleDir(dir: string): string {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length === 1 && entries[0]?.isDirectory()) {
    return path.join(dir, entries[0].name);
  }
  return dir;
}
