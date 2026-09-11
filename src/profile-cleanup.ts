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

/** Only known generated names, old regular files, and empty owned directories are removed. */
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
  const removeOld = (file: string): void => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.mtimeMs > cutoff) return;
      durableRemoveFileSync(file);
      removed++;
    } catch {
      /* A locked or concurrently removed orphan can wait until the next sweep. */
    }
  };
  const removeEmptyOldDirectory = (directory: string): void => {
    try {
      const stat = fs.lstatSync(directory);
      if (stat.isDirectory() && stat.mtimeMs <= cutoff && owned(directory)) fs.rmdirSync(directory);
    } catch {
      /* Preserve recent, nonempty, locked and foreign directories. */
    }
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
        removeOld(path.join(location, file.name));
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
      if (entry.isFile() && VALIDATION_FILE.test(entry.name)) removeOld(location);
      if (entry.isDirectory() && /^core-download-[A-Za-z0-9]{6}$/.test(entry.name)) {
        for (const file of entries(location))
          if (coreNames.has(file.name)) removeOld(path.join(location, file.name));
        removeEmptyOldDirectory(location);
      }
    }
  }
  return removed;
}
