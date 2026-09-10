import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import { loadSettings } from "./app-state.js";
import { fetchWithRetry, readErrorSummary } from "./http.js";
import { type Installation, inspectInstallation, type NpmInstallation } from "./installation.js";
import {
  exactSashVersion,
  parseSashPackageInfo,
  SASH_PACKAGE_NAME,
  type SashPackageInfo,
  supportsNode,
} from "./package-info.js";
import { sashLayout } from "./paths.js";
import { buildSanitizedEnv } from "./process.js";
import {
  ensureManagement,
  type RuntimeContext,
  resolveRuntimeOwner,
  stopRuntime,
} from "./runtime-owner.js";

const NPM_REGISTRY = "https://registry.npmjs.org";
const NPM_INSTALL_TIMEOUT_MS = 15 * 60_000;

export interface SashUpgradeCheck {
  current: string;
  target: string | null;
  available: boolean;
  compatible: boolean;
  supported: boolean;
  installation: Installation["kind"];
  prefix?: string;
  node: string;
  requiredNode?: string;
  reason?: string;
}
export interface SashUpgradeInspection {
  report: SashUpgradeCheck;
  installation: Installation;
  target?: SashPackageInfo;
}

/** Published Sash manifest for one exact version, or for the `latest` tag. */
export async function resolveSashUpgradeTarget(
  version?: string,
  signal?: AbortSignal,
): Promise<SashPackageInfo> {
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
  const target = parseSashPackageInfo(value);
  if (version !== undefined && target.version !== tag)
    throw new Error("The npm registry returned a different Sash version");
  return target;
}

/** `sash upgrade --check` is entirely observational: no locks, daemon or state initialization. */
export async function inspectSashUpgrade(
  version?: string,
  options: { packageRoot?: string; nodeVersion?: string } = {},
): Promise<SashUpgradeInspection> {
  const installation = inspectInstallation({ packageRoot: options.packageRoot });
  const current = parseSashPackageInfo(
    JSON.parse(fs.readFileSync(path.join(installation.packageRoot, "package.json"), "utf8")),
  ).version;
  const nodeVersion = options.nodeVersion ?? process.version;
  const base = {
    current,
    target: null,
    available: false,
    compatible: false,
    supported: installation.kind === "npm-global",
    installation: installation.kind,
    node: nodeVersion,
  };
  if (installation.kind !== "npm-global")
    return { installation, report: { ...base, reason: installation.reason } };
  const target = await resolveSashUpgradeTarget(version);
  const available =
    version !== undefined ? target.version !== current : semver.gt(target.version, current);
  const compatible = !available || supportsNode(target, nodeVersion);
  return {
    installation,
    target,
    report: {
      ...base,
      prefix: installation.prefix,
      target: target.version,
      available,
      compatible,
      requiredNode: target.nodeRange,
      ...(available && !compatible
        ? { reason: `Sash ${target.version} requires Node ${target.nodeRange}` }
        : {}),
    },
  };
}

/** Resolve the npm CLI as a Node script so no shell is involved on any platform. */
export function resolveNpmCli(nodePath = process.execPath, env = process.env): string {
  const candidates = [
    path.join(path.dirname(nodePath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  if (env.npm_execpath && path.isAbsolute(env.npm_execpath)) candidates.push(env.npm_execpath);
  for (const directory of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    candidates.push(path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"));
  }
  const found = candidates.find((candidate) => {
    try {
      return path.basename(candidate) === "npm-cli.js" && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!found) {
    throw new Error(
      "Cannot find the npm CLI; install npm alongside the Node executable before upgrading Sash",
    );
  }
  return found;
}

/** Child processes never inherit Sash's own credentials or Node injection hooks. */
function upgradeChildEnv(source = process.env): NodeJS.ProcessEnv {
  const env = buildSanitizedEnv(source);
  for (const key of Object.keys(env)) {
    if (
      key.toLowerCase().startsWith("npm_config_") ||
      [
        "NODE_OPTIONS",
        "NODE_PATH",
        "SASH_DEVELOPMENT",
        "SASH_AUTOSTART_NODE",
        "SASH_AUTOSTART_ENTRY",
      ].includes(key.toUpperCase())
    ) {
      delete env[key];
    }
  }
  return env;
}

function runNpmInstall(
  installation: NpmInstallation,
  version: string,
  options: { json?: boolean } = {},
): Promise<void> {
  const npm = resolveNpmCli(installation.nodePath);
  const args = [
    npm,
    "install",
    "--global",
    "--prefix",
    installation.prefix,
    "--no-audit",
    "--no-fund",
    `${SASH_PACKAGE_NAME}@${version}`,
  ];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(installation.nodePath, args, {
      cwd: installation.prefix,
      env: upgradeChildEnv(),
      // npm reports progress on stderr in --json mode so stdout stays parseable.
      stdio: options.json ? ["ignore", 2, 2] : ["ignore", "inherit", "inherit"],
      shell: false,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Installing Sash ${version} timed out`));
    }, NPM_INSTALL_TIMEOUT_MS);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm install --global failed with exit code ${code ?? "signal"}`));
    });
  });
}

/**
 * Install one exact Sash version with npm and restart the daemon on the new
 * code. The daemon runs from the package directory npm replaces, so it is
 * stopped first and started again only after the install succeeded.
 */
export interface SashUpgradeOutcome {
  version: string;
  /** The version the package held before this upgrade, when one was installed. */
  previousVersion: string | null;
  /** True when the daemon was restarted onto the new code as part of this run. */
  restarted: boolean;
}

/** Seams for the upgrade sequence so its order can be tested without npm or a daemon. */
export interface SashUpgradeDeps {
  resolveTarget?: typeof resolveSashUpgradeTarget;
  resolveOwner?: typeof resolveRuntimeOwner;
  stop?: typeof stopRuntime;
  start?: typeof ensureManagement;
  install?: (
    installation: NpmInstallation,
    version: string,
    options: { json?: boolean },
  ) => Promise<void>;
}

/**
 * Install one exact Sash version with npm and restart the daemon on the new
 * code. The package is replaced first, while the running daemon keeps serving:
 * on a machine whose only route to the registry is the proxy that daemon runs,
 * stopping it first would make the install impossible. Nothing needs undoing
 * when the install fails, because nothing was stopped.
 */
export async function executeSashUpgrade(
  installation: NpmInstallation,
  options: { version?: string; json?: boolean; restart?: boolean } = {},
  deps: SashUpgradeDeps = {},
): Promise<SashUpgradeOutcome> {
  const target = await (deps.resolveTarget ?? resolveSashUpgradeTarget)(options.version);
  const previousVersion = versionOnDisk(installation);
  await (deps.install ?? runNpmInstall)(installation, target.version, options);

  const layout = sashLayout();
  const context: RuntimeContext = { layout, settings: loadSettings(layout) };
  const owner = await (deps.resolveOwner ?? resolveRuntimeOwner)(context);
  const shouldRestart = owner.kind === "daemon" && options.restart !== false;
  if (!shouldRestart) return { version: target.version, previousVersion, restarted: false };

  // The daemon still executes the previous code from memory; only a restart
  // loads the new one. The install is complete, so the few seconds without a
  // proxy change nothing.
  await (deps.stop ?? stopRuntime)(context);
  await (deps.start ?? ensureManagement)(context);
  return { version: target.version, previousVersion, restarted: true };
}

/** Best-effort version of the package currently on disk, read before it is replaced. */
function versionOnDisk(installation: NpmInstallation): string | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(installation.packageRoot, "package.json"), "utf8"))
      .version as string;
  } catch {
    return null;
  }
}
