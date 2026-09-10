import fs from "node:fs";
import path from "node:path";
import { readBoundedJsonFile } from "./bounded-file.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { fetchWithRetry, readErrorSummary } from "./http.js";
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
export type SashNpmTarget = SashPackageInfo;

export function parseSashNpmTarget(value: unknown): SashNpmTarget {
  return parseSashPackageInfo(value);
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
  onStage?: (stage: string) => void;
  runCommand?: typeof runUpgradeCommand;
}): Promise<string> {
  const paths = upgradeTransactionPaths(options.prefix, options.transactionId);
  const npm = resolveNpmCli(options.nodePath);
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
  await (options.runCommand ?? runUpgradeCommand)(
    options.nodePath,
    [
      npm,
      "install",
      ...common,
      "--install-strategy=nested",
      "--omit=dev",
      `${SASH_PACKAGE_NAME}@${options.target.version}`,
    ],
    {
      cwd: paths.root,
      purpose: "Prepare Sash and its dependencies",
      timeoutMs: 15 * 60_000,
      signal: options.signal,
      env,
    },
  );
  return npmPackageRoot(paths.stage);
}
