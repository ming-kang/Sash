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
  kind: "source" | "linked" | "npx" | "pnpm" | "yarn" | "bun" | "unknown";
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

export function installationId(packageRoot: string): string {
  return installationIdFromCanonicalPath(canonicalPath(packageRoot));
}

export function installationIdFromCanonicalPath(root: string): string {
  assertAbsolutePath(root);
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

export function npmShimPaths(prefix: string, platform = process.platform): string[] {
  return platform === "win32"
    ? [path.join(prefix, "sash"), path.join(prefix, "sash.cmd"), path.join(prefix, "sash.ps1")]
    : [path.join(prefix, "bin", "sash")];
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

/** Read-only installation ownership detection shared by startup and self-upgrade. */
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
    const parts = path.resolve(packageRoot).replaceAll("\\", "/").toLowerCase().split("/");
    for (const [marker, kind] of [
      ["_npx", "npx"],
      [".pnpm", "pnpm"],
      [".yarn", "yarn"],
      [".bun", "bun"],
    ] as const) {
      if (parts.includes(marker))
        return unsupported(
          kind,
          `This installation is managed by ${kind}; update it with that package manager.`,
        );
    }
    const scope = path.dirname(packageRoot);
    const modules = path.dirname(scope);
    if (
      path.basename(packageRoot).toLowerCase() !== "sash" ||
      path.basename(scope) !== "@astralyn" ||
      path.basename(modules) !== "node_modules"
    )
      return unsupported(
        "source",
        "This is a source, linked or local installation; update its checkout or package manager.",
      );
    for (const directory of [packageRoot, scope, modules]) {
      if (!fs.lstatSync(directory).isDirectory())
        return unsupported(
          "linked",
          "Linked installations must be updated through their source checkout.",
        );
    }
    const parent = path.dirname(modules);
    if (platform !== "win32" && path.basename(parent) !== "lib")
      return unsupported("source", "The package is outside an npm global installation.");
    const prefix = platform === "win32" ? parent : path.dirname(parent);
    for (const marker of ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
      if (fs.existsSync(path.join(prefix, marker)))
        return unsupported(
          "source",
          "A project manifest or lockfile occupies the installation prefix.",
        );
    }
    const cliPath = path.join(packageRoot, SASH_CLI_ENTRY);
    if (!fs.statSync(nodePath).isFile() || !fs.lstatSync(cliPath).isFile())
      return unsupported("unknown", "The Node executable or Sash CLI entry is missing or linked.");
    if (platform === "win32") {
      const shim = path.join(prefix, "sash.cmd");
      const stat = fs.lstatSync(shim);
      if (!stat.isFile() || stat.size > 64 * 1024)
        return unsupported("unknown", "The npm command shim cannot be verified.");
      const contents = fs.readFileSync(shim, "utf8").replaceAll("/", "\\").toLowerCase();
      if (!contents.includes("node_modules\\@astralyn\\sash\\dist\\cli.js"))
        return unsupported("unknown", "The npm command shim does not target this Sash package.");
    } else if (
      !pathsEqual(canonicalPath(path.join(prefix, "bin", "sash")), canonicalPath(cliPath))
    ) {
      return unsupported("unknown", "The npm bin link does not target this Sash package.");
    }
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
