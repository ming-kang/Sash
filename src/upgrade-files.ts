import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readBoundedFile } from "./bounded-file.js";
import { isSha256 } from "./core-integrity.js";
import { errnoCode } from "./error-utils.js";
import {
  atomicWriteFileSync,
  durableRemoveFileSync,
  durableRenameSync,
  pathEntryExists,
} from "./fs-atomic.js";
import { canonicalPath, pathsEqual } from "./installation.js";
import { hasExactOwnKeys, isPlainObject } from "./json-shape.js";

export interface TreeFingerprint {
  sha256: string;
  entries: number;
  bytes: number;
  manifest: TreeEntry[];
}
export type TreeEntry =
  | [string, "link", string]
  | [string, "directory", number]
  | [string, "file", number, number, string];
export type ShimImage =
  | { kind: "absent" }
  | { kind: "file"; sha256: string; base64: string; mode: number }
  | { kind: "link"; target: string };

export function isInsideDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

/** A bounded tree digest includes names, kinds, contents and executable permissions, never mtimes. */
export function fingerprintTree(
  root: string,
  options: { allowDanglingLinks?: boolean } = {},
): TreeFingerprint {
  if (!fs.lstatSync(root).isDirectory())
    throw new Error(`Package slot must be a regular directory: ${root}`);
  const canonicalRoot = canonicalPath(root);
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let entries = 0;
  let bytes = 0;
  const manifest: TreeEntry[] = [];
  const record = (entry: TreeEntry): void => {
    manifest.push(entry);
    hash.update(`${JSON.stringify(entry)}\n`);
  };
  const walk = (directory: string, depth: number): void => {
    if (depth > 64) throw new Error("Sash package directory nesting exceeds its limit");
    for (const name of fs.readdirSync(directory).sort()) {
      if (++entries > 100_000) throw new Error("Sash package contains too many entries");
      const file = path.join(directory, name);
      const relative = path.relative(root, file).split(path.sep).join("/");
      const stat = fs.lstatSync(file);
      const mode = process.platform === "win32" ? 0 : stat.mode & 0o777;
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        if (
          path.isAbsolute(target) ||
          !isInsideDirectory(canonicalRoot, path.resolve(path.dirname(file), target)) ||
          (!options.allowDanglingLinks && !isInsideDirectory(canonicalRoot, canonicalPath(file)))
        )
          throw new Error(`Package link escapes its owned directory: ${relative}`);
        record([relative, "link", target]);
      } else if (stat.isDirectory()) {
        record([relative, "directory", mode]);
        walk(file, depth + 1);
      } else if (stat.isFile()) {
        if (stat.size > 512 * 1024 * 1024)
          throw new Error(`Package file exceeds its size limit: ${relative}`);
        const fd = fs.openSync(
          file,
          fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW),
        );
        const digest = crypto.createHash("sha256");
        let count = 0;
        try {
          const opened = fs.fstatSync(fd);
          if (!opened.isFile() || opened.size !== stat.size)
            throw new Error("Package changed during inspection");
          for (;;) {
            const read = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (!read) break;
            count += read;
            bytes += read;
            if (count > 512 * 1024 * 1024 || bytes > 2 * 1024 * 1024 * 1024)
              throw new Error("Sash package exceeds its size limit");
            digest.update(buffer.subarray(0, read));
          }
          if (count !== stat.size) throw new Error("Package changed during inspection");
        } finally {
          fs.closeSync(fd);
        }
        record([relative, "file", count, mode, digest.digest("hex")]);
      } else throw new Error(`Unsupported package file type: ${relative}`);
    }
  };
  walk(root, 0);
  return { sha256: hash.digest("hex"), entries, bytes, manifest };
}

export function parseTreeFingerprint(value: unknown): TreeFingerprint {
  if (
    !isPlainObject(value) ||
    !hasExactOwnKeys(value, ["sha256", "entries", "bytes", "manifest"]) ||
    !isSha256(value.sha256) ||
    typeof value.entries !== "number" ||
    !Number.isSafeInteger(value.entries) ||
    value.entries < 1 ||
    value.entries > 100_000 ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > 2 * 1024 * 1024 * 1024 ||
    !Array.isArray(value.manifest) ||
    value.manifest.length !== value.entries
  )
    throw new Error("Invalid package fingerprint");
  const mode = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0o777;
  const manifest = value.manifest.map((entry: unknown): TreeEntry => {
    if (
      !Array.isArray(entry) ||
      typeof entry[0] !== "string" ||
      !entry[0] ||
      entry[0].length > 4096 ||
      path.isAbsolute(entry[0]) ||
      entry[0].includes("\\") ||
      entry[0].split("/").some((part) => [".", "..", ""].includes(part))
    )
      throw new Error("Invalid package manifest path");
    if (entry[1] === "directory" && entry.length === 3 && mode(entry[2]))
      return [entry[0], "directory", entry[2]];
    if (
      entry[1] === "link" &&
      entry.length === 3 &&
      typeof entry[2] === "string" &&
      entry[2] &&
      entry[2].length <= 4096 &&
      !path.isAbsolute(entry[2])
    )
      return [entry[0], "link", entry[2]];
    if (
      entry[1] === "file" &&
      entry.length === 5 &&
      typeof entry[2] === "number" &&
      Number.isSafeInteger(entry[2]) &&
      entry[2] >= 0 &&
      entry[2] <= 512 * 1024 * 1024 &&
      mode(entry[3]) &&
      isSha256(entry[4])
    )
      return [entry[0], "file", entry[2], entry[3], entry[4]];
    throw new Error("Invalid package manifest entry");
  });
  const hash = crypto.createHash("sha256");
  for (const entry of manifest) hash.update(`${JSON.stringify(entry)}\n`);
  if (
    new Set(manifest.map((entry) => entry[0])).size !== manifest.length ||
    manifest.reduce((total, entry) => total + (entry[1] === "file" ? entry[2] : 0), 0) !==
      value.bytes ||
    hash.digest("hex") !== value.sha256
  )
    throw new Error("Package manifest does not match its fingerprint");
  return { sha256: value.sha256, entries: value.entries, bytes: value.bytes, manifest };
}

export function assertTreeFingerprint(root: string, expected: TreeFingerprint): void {
  const actual = fingerprintTree(root);
  if (
    actual.sha256 !== expected.sha256 ||
    actual.entries !== expected.entries ||
    actual.bytes !== expected.bytes
  )
    throw new Error(`Package ownership verification failed; files preserved: ${root}`);
}

export function readShimImage(file: string): ShimImage {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { kind: "absent" };
    throw error;
  }
  if (stat.isSymbolicLink()) return { kind: "link", target: fs.readlinkSync(file) };
  const contents = readBoundedFile(file, 64 * 1024);
  return {
    kind: "file",
    sha256: crypto.hash("sha256", contents),
    base64: contents.toString("base64"),
    mode: process.platform === "win32" ? 0o666 : stat.mode & 0o777,
  };
}

export function parseShimImage(value: unknown): ShimImage {
  if (!isPlainObject(value)) throw new Error("Invalid npm shim image");
  if (value.kind === "absent" && hasExactOwnKeys(value, ["kind"])) return { kind: "absent" };
  if (
    value.kind === "link" &&
    hasExactOwnKeys(value, ["kind", "target"]) &&
    typeof value.target === "string" &&
    value.target.length < 4096 &&
    value.target &&
    !path.isAbsolute(value.target) &&
    !Array.from(value.target).some(
      (character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
    )
  )
    return { kind: "link", target: value.target };
  if (
    value.kind === "file" &&
    hasExactOwnKeys(value, ["kind", "sha256", "base64", "mode"]) &&
    isSha256(value.sha256) &&
    typeof value.base64 === "string" &&
    value.base64.length <= 87384 &&
    typeof value.mode === "number" &&
    Number.isInteger(value.mode) &&
    value.mode >= 0 &&
    value.mode <= 0o777
  ) {
    const bytes = Buffer.from(value.base64, "base64");
    if (
      bytes.length <= 64 * 1024 &&
      bytes.toString("base64") === value.base64 &&
      crypto.hash("sha256", bytes) === value.sha256
    )
      return { kind: "file", sha256: value.sha256, base64: value.base64, mode: value.mode };
  }
  throw new Error("Invalid npm shim image");
}

export function shimImagesEqual(left: ShimImage, right: ShimImage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Replace only an observed owned image. Symlink publication also uses same-directory rename. */
export function replaceShim(
  file: string,
  expected: ShimImage,
  next: ShimImage,
  prefix: string,
): void {
  if (!isInsideDirectory(canonicalPath(prefix), canonicalPath(path.dirname(file)))) {
    if (!pathsEqual(canonicalPath(path.dirname(file)), canonicalPath(prefix)))
      throw new Error("npm shim escaped its installation prefix");
  }
  if (!shimImagesEqual(readShimImage(file), expected))
    throw new Error(`npm shim ownership changed; preserved ${file}`);
  parseShimImage(next);
  if (next.kind === "absent") durableRemoveFileSync(file);
  else if (next.kind === "file")
    atomicWriteFileSync(file, Buffer.from(next.base64, "base64"), next.mode);
  else {
    if (!isInsideDirectory(prefix, path.resolve(path.dirname(file), next.target)))
      throw new Error("npm bin link escapes its installation prefix");
    const temporary = path.join(
      path.dirname(file),
      `.sash-link-${crypto.randomBytes(12).toString("hex")}`,
    );
    fs.symlinkSync(next.target, temporary, "file");
    try {
      durableRenameSync(temporary, file);
    } finally {
      if (pathEntryExists(temporary)) durableRemoveFileSync(temporary);
    }
  }
}

/** Check both the resolved deletion boundary and every byte of a completed owned package slot. */
export function removePackageSlot(
  slot: string,
  expected: TreeFingerprint,
  transactionRoot: string,
): void {
  const root = canonicalPath(transactionRoot);
  const target = canonicalPath(slot);
  if (!isInsideDirectory(root, target))
    throw new Error("Package cleanup escaped its transaction directory");
  const remaining = fingerprintTree(slot, { allowDanglingLinks: true });
  const original = new Map(expected.manifest.map((entry) => [entry[0], JSON.stringify(entry)]));
  for (const entry of remaining.manifest) {
    if (original.get(entry[0]) !== JSON.stringify(entry))
      throw new Error(`Package cleanup found changed or unknown content; preserved ${slot}`);
  }
  // A per-file manifest authenticates remaining bytes after an interrupted recursive cleanup.
  for (const entry of [...remaining.manifest].reverse()) {
    const file = path.join(target, ...entry[0].split("/"));
    if (entry[1] === "directory") fs.rmdirSync(file);
    else durableRemoveFileSync(file);
  }
  fs.rmdirSync(target);
}
