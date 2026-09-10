import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "./error-utils.js";
import { currentPackageRoot, SASH_CLI_ENTRY } from "./package-info.js";

export interface NpmInstallation {
  kind: "npm-global";
  id: string;
  packageRoot: string;
  prefix: string;
  binDir: string;
  cliPath: string;
  nodePath: string;
  platform: NodeJS.Platform;
}
export interface UnsupportedInstallation {
  kind: "source" | "linked" | "unknown";
  packageRoot: string;
  reason: string;
}
export type Installation = NpmInstallation | UnsupportedInstallation;

export function assertAbsolutePath(value: string): void {
  if (
    !path.isAbsolute(value) ||
    Array.from(value).some((c) => c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 127)
  )
    throw new Error("Installation paths must be absolute and contain no control characters");
}

export function canonicalPath(value: string): string {
  assertAbsolutePath(value);
  return fs.realpathSync.native(value);
}

export function pathsEqual(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Opaque identity for this package directory, exposed through the daemon health API. */
export function installationId(packageRoot: string): string {
  const root = canonicalPath(packageRoot);
  return crypto.hash("sha256", process.platform === "win32" ? root.toLowerCase() : root);
}

export function npmPackageRoot(prefix: string, platform = process.platform): string {
  return path.join(
    prefix,
    ...(platform === "win32" ? [] : ["lib"]),
    "node_modules",
    "@astralyn",
    "sash",
  );
}

/** Structural lookup also works while the active package slot is temporarily absent. */
export function npmPrefixForPackage(
  packageRoot: string,
  platform = process.platform,
): string | undefined {
  const modules = path.dirname(path.dirname(packageRoot));
  const prefix = platform === "win32" ? path.dirname(modules) : path.dirname(path.dirname(modules));
  return pathsEqual(npmPackageRoot(prefix, platform), packageRoot) ? prefix : undefined;
}

/**
 * Read-only installation ownership detection. Only an `npm install --global`
 * layout can be replaced by `npm install --global`; everything else is reported
 * back to the user so their package manager or checkout stays in charge.
 */
export function inspectInstallation(
  options: { packageRoot?: string; nodePath?: string; platform?: NodeJS.Platform } = {},
): Installation {
  const packageRoot = options.packageRoot ?? currentPackageRoot();
  const nodePath = options.nodePath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const unsupported = (
    kind: UnsupportedInstallation["kind"],
    reason: string,
  ): UnsupportedInstallation => ({ kind, packageRoot, reason });
  try {
    assertAbsolutePath(packageRoot);
    assertAbsolutePath(nodePath);
    if (
      path.basename(packageRoot).toLowerCase() !== "sash" ||
      path.basename(path.dirname(packageRoot)) !== "@astralyn" ||
      path.basename(path.dirname(path.dirname(packageRoot))) !== "node_modules"
    ) {
      return unsupported(
        "source",
        "This is a source, linked or local installation; update its checkout or package manager.",
      );
    }
    const prefix = npmPrefixForPackage(packageRoot, platform);
    if (!prefix) return unsupported("source", "The package is outside an npm global installation.");
    const cliPath = path.join(packageRoot, SASH_CLI_ENTRY);
    if (!fs.existsSync(cliPath))
      return unsupported("unknown", "The Sash CLI entry is missing from this package.");
    return {
      kind: "npm-global",
      id: installationId(packageRoot),
      packageRoot: canonicalPath(packageRoot),
      prefix: canonicalPath(prefix),
      binDir:
        platform === "win32" ? canonicalPath(prefix) : path.join(canonicalPath(prefix), "bin"),
      cliPath: canonicalPath(cliPath),
      nodePath: canonicalPath(nodePath),
      platform,
    };
  } catch (error) {
    return unsupported("unknown", `Cannot verify the installation: ${errorMessage(error)}`);
  }
}
