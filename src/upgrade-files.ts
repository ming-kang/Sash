import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readBoundedFile } from "./bounded-file.js";
import { errnoCode } from "./error-utils.js";
import {
  atomicWriteFileSync,
  durableRemoveFileSync,
  durableRenameSync,
  pathEntryExists,
} from "./fs-atomic.js";
import { canonicalPath, pathsEqual } from "./installation.js";
import { hasExactOwnKeys, isPlainObject } from "./json-shape.js";

/** Directory identity survives rename and requires no scan of package contents. */
export interface PackageIdentity {
  device: string;
  inode: string;
}
export type ShimImage =
  | { kind: "absent" }
  | { kind: "file"; base64: string; mode: number }
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

export function readPackageIdentity(root: string): PackageIdentity {
  const stat = fs.lstatSync(root, { bigint: true });
  if (!stat.isDirectory() || stat.ino === 0n)
    throw new Error(`Package slot must be an identifiable regular directory: ${root}`);
  return { device: String(stat.dev), inode: String(stat.ino) };
}

export function parsePackageIdentity(value: unknown): PackageIdentity {
  if (
    !isPlainObject(value) ||
    !hasExactOwnKeys(value, ["device", "inode"]) ||
    typeof value.device !== "string" ||
    !/^(0|[1-9][0-9]{0,31})$/.test(value.device) ||
    typeof value.inode !== "string" ||
    !/^[1-9][0-9]{0,31}$/.test(value.inode)
  )
    throw new Error("Invalid Sash package directory identity");
  return { device: value.device, inode: value.inode };
}

export function packageIdentitiesEqual(
  left: PackageIdentity | undefined,
  right: PackageIdentity,
): boolean {
  return left?.device === right.device && left.inode === right.inode;
}

export function assertPackageIdentity(root: string, expected: PackageIdentity): void {
  if (!packageIdentitiesEqual(readPackageIdentity(root), expected))
    throw new Error(`Package directory was replaced outside the upgrade; preserved ${root}`);
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
  return {
    kind: "file",
    base64: readBoundedFile(file, 64 * 1024).toString("base64"),
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
    !Array.from(value.target).some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127)
  )
    return { kind: "link", target: value.target };
  if (
    value.kind === "file" &&
    hasExactOwnKeys(value, ["kind", "base64", "mode"]) &&
    typeof value.base64 === "string" &&
    value.base64.length <= 87384 &&
    typeof value.mode === "number" &&
    Number.isInteger(value.mode) &&
    value.mode >= 0 &&
    value.mode <= 0o777
  ) {
    const bytes = Buffer.from(value.base64, "base64");
    if (bytes.length <= 64 * 1024 && bytes.toString("base64") === value.base64)
      return { kind: "file", base64: value.base64, mode: value.mode };
  }
  throw new Error("Invalid npm shim image");
}

export function shimImagesEqual(left: ShimImage, right: ShimImage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Publish only a command entry still owned by this transaction. */
export function replaceShim(
  file: string,
  expected: ShimImage,
  next: ShimImage,
  prefix: string,
): void {
  const parent = canonicalPath(path.dirname(file));
  if (
    !isInsideDirectory(canonicalPath(prefix), parent) &&
    !pathsEqual(parent, canonicalPath(prefix))
  )
    throw new Error("npm shim escaped its installation prefix");
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

/** Cleanup owns the directory, not a per-file manifest; filesystem removal does not follow links. */
export async function removePackageSlot(
  slot: string,
  expected: PackageIdentity,
  transactionRoot: string,
): Promise<void> {
  const root = canonicalPath(transactionRoot);
  const target = canonicalPath(slot);
  if (!isInsideDirectory(root, target))
    throw new Error("Package cleanup escaped its transaction directory");
  assertPackageIdentity(slot, expected);
  await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
