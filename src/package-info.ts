import path from "node:path";
import semver from "semver";
import { readBoundedJsonFile } from "./bounded-file.js";
import { isPlainObject } from "./json-shape.js";

export const SASH_PACKAGE_NAME = "@astralyn/sash";
export const SASH_CLI_ENTRY = "dist/cli.js";
export const UPGRADE_PROTOCOL = 1;

export interface SashPackageInfo {
  name: typeof SASH_PACKAGE_NAME;
  version: string;
  nodeRange: string;
}

export function currentPackageRoot(): string {
  return path.resolve(import.meta.dirname, "..");
}

/** Exact versions only: never let an npm URL, range or local path become an install spec. */
export function exactSashVersion(value: unknown): string {
  if (typeof value !== "string" || value.length > 256)
    throw new Error("Expected an exact Sash version");
  const version = value.trim();
  const parsed = semver.parse(version);
  const canonical = parsed
    ? `${parsed.version}${parsed.build.length ? `+${parsed.build.join(".")}` : ""}`
    : null;
  if (!parsed || version !== canonical) throw new Error(`Invalid exact Sash version: ${version}`);
  return version;
}

export function parseSashPackageInfo(value: unknown): SashPackageInfo {
  if (!isPlainObject(value) || value.name !== SASH_PACKAGE_NAME)
    throw new Error(`Expected package ${SASH_PACKAGE_NAME}`);
  if (!isPlainObject(value.bin) || value.bin.sash !== SASH_CLI_ENTRY)
    throw new Error("The Sash package has an unsupported CLI entry");
  const range = isPlainObject(value.engines) ? value.engines.node : undefined;
  if (typeof range !== "string" || range.length > 256 || !semver.validRange(range))
    throw new Error("The Sash package has no valid Node requirement");
  return { name: SASH_PACKAGE_NAME, version: exactSashVersion(value.version), nodeRange: range };
}

export function readSashPackageInfo(root = currentPackageRoot()): SashPackageInfo {
  const file = path.join(root, "package.json");
  try {
    return parseSashPackageInfo(readBoundedJsonFile(file, 64 * 1024));
  } catch (cause) {
    throw new Error(`Cannot read Sash package manifest: ${file}`, { cause });
  }
}

export function supportsNode(info: SashPackageInfo, nodeVersion = process.version): boolean {
  return semver.satisfies(nodeVersion, info.nodeRange, { includePrerelease: true });
}
