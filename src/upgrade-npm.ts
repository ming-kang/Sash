import fs from "node:fs";
import path from "node:path";
import { readBoundedJsonFile } from "./bounded-file.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { downloadToFile, fetchWithRetry, readErrorSummary } from "./http.js";
import { canonicalPath, npmPackageRoot } from "./installation.js";
import { isPlainObject } from "./json-shape.js";
import {
  exactSashVersion,
  parseSashPackageInfo,
  SASH_PACKAGE_NAME,
  type SashPackageInfo,
} from "./package-info.js";
import { runUpgradeCommand, upgradeChildEnv } from "./upgrade-command.js";
import { upgradeTransactionPaths } from "./upgrade-paths.js";

export const NPM_REGISTRY = "https://registry.npmjs.org";
export interface SashNpmTarget extends SashPackageInfo {
  tarball: string;
  integrity: { algorithm: "sha512"; digest: string };
}

export function parseSashNpmTarget(value: unknown): SashNpmTarget {
  const info = parseSashPackageInfo(value);
  if (
    !isPlainObject(value) ||
    !isPlainObject(value.dist) ||
    typeof value.dist.tarball !== "string" ||
    typeof value.dist.integrity !== "string"
  )
    throw new Error("Sash release is missing its npm tarball integrity metadata");
  const url = new URL(value.dist.tarball);
  if (
    url.origin !== NPM_REGISTRY ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith("/@astralyn/sash/-/")
  )
    throw new Error("Sash tarballs must come from the official npm registry");
  const integrity = value.dist.integrity.match(/^sha512-([A-Za-z0-9+/]{86}==)$/)?.[1];
  if (!integrity) throw new Error("Sash release requires a canonical npm SHA-512 integrity digest");
  const digest = Buffer.from(integrity, "base64");
  if (digest.length !== 64 || digest.toString("base64") !== integrity)
    throw new Error("Invalid npm integrity digest");
  return {
    ...info,
    tarball: url.href,
    integrity: { algorithm: "sha512", digest: digest.toString("hex") },
  };
}

export async function resolveSashNpmTarget(
  version?: string,
  signal?: AbortSignal,
): Promise<SashNpmTarget> {
  const tag = version === undefined ? "latest" : exactSashVersion(version);
  const response = await fetchWithRetry(
    `${NPM_REGISTRY}/${encodeURIComponent(SASH_PACKAGE_NAME)}/${encodeURIComponent(tag)}`,
    { attempts: 2, deadlineMs: 20_000, manualRedirect: true, signal },
  );
  if (response.statusCode !== 200) {
    await readErrorSummary(response);
    throw new Error(
      `Cannot resolve Sash ${tag}: npm registry returned HTTP ${response.statusCode}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(await response.text(1024 * 1024)) as unknown;
  } catch {
    signal?.throwIfAborted();
    throw new Error("The npm registry returned an invalid Sash manifest");
  }
  const target = parseSashNpmTarget(value);
  if (version !== undefined && target.version !== tag)
    throw new Error("The npm registry returned a different Sash version");
  return target;
}

export function resolveNpmCli(nodePath = process.execPath, env = process.env): string {
  const candidates = [
    path.join(path.dirname(nodePath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  if (env.npm_execpath && path.isAbsolute(env.npm_execpath)) candidates.push(env.npm_execpath);
  for (const directory of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    candidates.push(path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"));
    if (process.platform !== "win32") candidates.push(path.join(directory, "npm"));
  }
  for (const candidate of candidates) {
    try {
      const cli = canonicalPath(candidate);
      if (
        path.basename(cli) !== "npm-cli.js" ||
        path.basename(path.dirname(cli)) !== "bin" ||
        !fs.statSync(cli).isFile()
      )
        continue;
      const manifest = readBoundedJsonFile(
        path.join(path.dirname(path.dirname(cli)), "package.json"),
        128 * 1024,
      );
      if (
        isPlainObject(manifest) &&
        manifest.name === "npm" &&
        isPlainObject(manifest.bin) &&
        manifest.bin.npm === "bin/npm-cli.js"
      )
        return cli;
    } catch {
      /* Inspect the next real npm installation. */
    }
  }
  throw new Error(
    "Cannot find the npm CLI; install npm alongside the Node executable before upgrading Sash",
  );
}

export async function stageSashPackage(options: {
  prefix: string;
  transactionId: string;
  nodePath: string;
  target: SashNpmTarget;
  signal?: AbortSignal;
  onProgress?: (downloaded: number, total?: number) => void;
  onStage?: (stage: string) => void;
}): Promise<string> {
  const paths = upgradeTransactionPaths(options.prefix, options.transactionId);
  const npm = resolveNpmCli(options.nodePath);
  options.onStage?.("downloading");
  await downloadToFile(options.target.tarball, paths.archive, {
    allowedHosts: new Set(["registry.npmjs.org"]),
    requireHttps: true,
    integrity: options.target.integrity,
    maxBytes: 128 * 1024 * 1024,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  atomicWriteFileSync(paths.config, "");
  atomicWriteFileSync(paths.globalConfig, "");
  const common = [
    "--global",
    "--prefix",
    paths.stage,
    "--cache",
    paths.cache,
    "--registry",
    NPM_REGISTRY,
    "--userconfig",
    paths.config,
    "--globalconfig",
    paths.globalConfig,
    "--no-audit",
    "--no-fund",
  ];
  const env = { ...upgradeChildEnv(), SASH_HOME: paths.validationData };
  options.onStage?.("dependencies");
  await runUpgradeCommand(
    options.nodePath,
    [npm, "install", ...common, "--install-strategy=nested", "--omit=dev", paths.archive],
    {
      cwd: paths.root,
      purpose: "Prepare Sash and its dependencies",
      timeoutMs: 15 * 60_000,
      signal: options.signal,
      env,
    },
  );
  options.onStage?.("dependency-check");
  await runUpgradeCommand(
    options.nodePath,
    [npm, "ls", ...common, "--all", "--omit=dev", "--json"],
    {
      cwd: paths.root,
      purpose: "Verify the prepared npm dependency tree",
      signal: options.signal,
      env,
    },
  );
  return npmPackageRoot(paths.stage);
}
