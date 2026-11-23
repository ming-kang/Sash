import fs from "node:fs";
import path from "node:path";
import { durableRemoveFileSync } from "./fs-atomic.js";
import type { SashLayout } from "./paths.js";
import type { ProfilesIndex } from "./profiles.js";

const MAX_AGE_MS = 24 * 60 * 60_000;
const REVISION = /^[1-9]\d*\.yaml$/;
const ATOMIC_REVISION = /^\.[1-9]\d*\.yaml\.[1-9]\d*\.[a-f0-9]{12}\.tmp$/;
const VALIDATION_FILE =
  /^\.?config-validate-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.yaml(?:\.[1-9]\d*\.[a-f0-9]{12}\.tmp)?$/;
/** Browser handoff pages written by `sash web` up to 0.5.4; nothing creates them anymore. */
const LEGACY_WEB_HANDOFF = /^web-bootstrap-\d{13}-[a-f0-9]{16}$/;

export function pruneProfileFiles(
  layout: SashLayout,
  index: ProfilesIndex,
  options: { nowMs?: number; cleanTemp?: boolean } = {},
): number {
  const root = fs.realpathSync.native(layout.root);
  const cutoff = (options.nowMs ?? Date.now()) - MAX_AGE_MS;
  let removed = 0;
  const owned = (file: string): boolean => {
    try {
      const relative = path.relative(root, fs.realpathSync.native(file));
      return (
        relative !== "" &&
        !relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative)
      );
    } catch {
      return false;
    }
  };
  const entries = (directory: string): fs.Dirent[] => {
    try {
      if (!fs.lstatSync(directory).isDirectory() || !owned(directory)) return [];
      return fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const tryRemoveOld = (file: string): void => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.mtimeMs > cutoff) return;
      durableRemoveFileSync(file);
      removed++;
    } catch {}
  };
  const removeEmptyOldDirectory = (directory: string): void => {
    try {
      const stat = fs.lstatSync(directory);
      if (stat.isDirectory() && stat.mtimeMs <= cutoff && owned(directory)) fs.rmdirSync(directory);
    } catch {}
  };
  const revisions = new Map(
    index.profiles.map((profile) => [profile.id, `${profile.revision}.yaml`]),
  );
  for (const directory of entries(layout.profilesDir)) {
    if (!directory.isDirectory() || !/^\d+$/.test(directory.name)) continue;
    const location = path.join(layout.profilesDir, directory.name);
    for (const file of entries(location)) {
      if (file.name === revisions.get(directory.name)) continue;
      if (REVISION.test(file.name) || ATOMIC_REVISION.test(file.name))
        tryRemoveOld(path.join(location, file.name));
    }
    if (!revisions.has(directory.name)) removeEmptyOldDirectory(location);
  }
  if (options.cleanTemp !== false) {
    const coreNames = new Set([
      "archive.download",
      path.basename(layout.coreExe),
      `${path.basename(layout.coreExe)}.extracted`,
    ]);
    for (const entry of entries(layout.tempDir)) {
      const location = path.join(layout.tempDir, entry.name);
      if (entry.isFile() && VALIDATION_FILE.test(entry.name)) tryRemoveOld(location);
      if (entry.isDirectory() && /^core-(?:staged|download)-[A-Za-z0-9]{6}$/.test(entry.name)) {
        for (const file of entries(location))
          if (coreNames.has(file.name)) tryRemoveOld(path.join(location, file.name));
        removeEmptyOldDirectory(location);
      }
      if (entry.isDirectory() && LEGACY_WEB_HANDOFF.test(entry.name)) {
        tryRemoveOld(path.join(location, "index.html"));
        removeEmptyOldDirectory(location);
      }
    }
  }
  return removed;
}
