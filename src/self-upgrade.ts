import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import { loadSettings } from "./app-state.js";
import type { AutostartStatus } from "./autostart/contract.js";
import { AutostartService } from "./autostart/service.js";
import {
  ensureDaemonSession,
  type HealthyDaemonSession,
  type RuntimeContext,
  resolveDaemonSession,
  stopRuntime,
} from "./daemon-session.js";
import { errorMessage } from "./error-utils.js";
import {
  type FetchResponse,
  fetchWithRetry,
  formatProxyFallbackWarning,
  readErrorSummary,
} from "./http.js";
import {
  exactSashVersion,
  parseSashPackageInfo,
  readSashPackageInfo,
  SASH_PACKAGE_NAME,
  type SashPackageInfo,
  supportsNode,
} from "./package-info.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { buildSanitizedEnv } from "./process.js";
import {
  type Installation,
  inspectInstallation,
  type NpmInstallation,
} from "./sash-installation.js";
import { StateMutationQueue } from "./state-lock.js";

const NPM_REGISTRY = "https://registry.npmjs.org";
const NPM_INSTALL_TIMEOUT_MS = 15 * 60_000;

function parseNpmRegistry(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.href.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/** `npm config get registry` reports the effective registry, honoring user mirrors (.npmrc, npm_config_registry). */
export async function resolveNpmRegistry(
  nodePath = process.execPath,
  probe: (nodePath: string) => Promise<string | undefined> = probeNpmRegistry,
): Promise<string> {
  const fromEnv = process.env.npm_config_registry;
  if (fromEnv) {
    const parsed = parseNpmRegistry(fromEnv);
    if (parsed) return parsed;
  }
  const probed = await probe(nodePath);
  if (probed) {
    const parsed = parseNpmRegistry(probed);
    if (parsed) return parsed;
  }
  return NPM_REGISTRY;
}

function probeNpmRegistry(nodePath: string): Promise<string | undefined> {
  let npm: string;
  try {
    npm = resolveNpmCli(nodePath);
  } catch {
    return Promise.resolve(undefined);
  }
  return new Promise<string | undefined>((resolve) => {
    const child = spawn(nodePath, [npm, "config", "get", "registry"], {
      env: upgradeChildEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, 10_000);
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (output.length < 4096) output += chunk;
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? output.trim() || undefined : undefined);
    });
  });
}

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

export async function resolveSashUpgradeTarget(
  version?: string,
  signal?: AbortSignal,
  registry = NPM_REGISTRY,
): Promise<SashPackageInfo> {
  const tag = version === undefined ? "latest" : exactSashVersion(version);
  const url = `${registry}/${encodeURIComponent(SASH_PACKAGE_NAME)}/${encodeURIComponent(tag)}`;
  const response: FetchResponse = await fetchWithRetry(url, {
    attempts: 2,
    deadlineMs: 20_000,
    signal,
    onProxyFallback: (info) => {
      process.stderr.write(`[sash] ${formatProxyFallbackWarning(info)}\n`);
    },
  });
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

export async function inspectSashUpgrade(
  version?: string,
  options: { packageRoot?: string; nodeVersion?: string; registry?: string } = {},
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
  const target = await resolveSashUpgradeTarget(
    version,
    undefined,
    options.registry ?? NPM_REGISTRY,
  );
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

export interface SashUpgradeOutcome {
  version: string;
  restarted: boolean;
  wasRunning: boolean;
  coreRestarted: boolean;
  coreRestartError?: string;
  autostartRepaired?: boolean;
}

export interface SashUpgradeDeps {
  resolveSession?: typeof resolveDaemonSession;
  stop?: typeof stopRuntime;
  start?: typeof ensureDaemonSession;
  startCore?: (owner: HealthyDaemonSession) => Promise<unknown>;
  inspectAutostart?: () => Promise<AutostartStatus>;
  install?: (
    installation: NpmInstallation,
    version: string,
    options: { json?: boolean },
  ) => Promise<void>;
}

export type SashUpgradePhase = "restarting" | "starting-core";

/** One upgrade at a time per data folder; a concurrent attempt fails fast instead of colliding inside npm. */
export async function executeSashUpgrade(
  installation: NpmInstallation,
  target: SashPackageInfo,
  options: {
    json?: boolean;
    restart?: boolean;
    onPhase?: (phase: SashUpgradePhase) => void;
  } = {},
  deps: SashUpgradeDeps = {},
): Promise<SashUpgradeOutcome> {
  const layout = sashLayout();
  try {
    return await new StateMutationQueue(layout.upgradeLockFile, 0).run("upgrade Sash", () =>
      runSashUpgradeSequence(installation, target, options, deps, layout),
    );
  } catch (error) {
    if (errorMessage(error).includes("is busy")) {
      throw new Error("another Sash upgrade is in progress — wait for it to finish", {
        cause: error,
      });
    }
    throw error;
  }
}

async function runSashUpgradeSequence(
  installation: NpmInstallation,
  target: SashPackageInfo,
  options: {
    json?: boolean;
    restart?: boolean;
    onPhase?: (phase: SashUpgradePhase) => void;
  },
  deps: SashUpgradeDeps,
  layout: SashLayout,
): Promise<SashUpgradeOutcome> {
  // Captured before npm overwrites the package; rollback needs the old version.
  const previousVersion = readPreviousVersion(installation);
  await (deps.install ?? runNpmInstall)(installation, target.version, options);

  const context: RuntimeContext = { layout, settings: loadSettings(layout) };
  const owner = await (deps.resolveSession ?? resolveDaemonSession)(context);
  const shouldRestart = owner.kind === "daemon" && options.restart !== false;
  if (!shouldRestart) {
    return {
      version: target.version,
      restarted: false,
      wasRunning: owner.kind === "daemon",
      coreRestarted: false,
    };
  }

  let coreWasRunning = false;
  if (owner.kind === "daemon" && owner.client) {
    try {
      const status = await owner.client.status();
      coreWasRunning = Boolean(status.core?.running);
    } catch {
      coreWasRunning = false;
    }
  }

  options.onPhase?.("restarting");
  await (deps.stop ?? stopRuntime)(context);
  let restarted: HealthyDaemonSession;
  try {
    restarted = await (deps.start ?? ensureDaemonSession)(context);
  } catch (error) {
    throw await explainUpgradeStartFailure(
      error,
      previousVersion,
      installation,
      options,
      deps,
      context,
    );
  }

  let coreRestarted = false;
  let coreRestartError: string | undefined;
  if (coreWasRunning) {
    options.onPhase?.("starting-core");
    try {
      await (deps.startCore ? deps.startCore(restarted) : restarted.client?.startCore());
      coreRestarted = true;
    } catch (error) {
      coreRestartError = errorMessage(error);
    }
  }

  const autostartRepaired = await repairStaleAutostart(restarted, layout, deps);

  return {
    version: target.version,
    restarted: true,
    wasRunning: true,
    coreRestarted,
    ...(coreRestartError !== undefined ? { coreRestartError } : {}),
    ...(autostartRepaired ? { autostartRepaired: true } : {}),
  };
}

function readPreviousVersion(installation: NpmInstallation): string | undefined {
  try {
    return readSashPackageInfo(installation.packageRoot).version;
  } catch {
    return undefined;
  }
}

/** Reinstall the previous version through npm, which owns package integrity. */
async function explainUpgradeStartFailure(
  error: unknown,
  previousVersion: string | undefined,
  installation: NpmInstallation,
  options: { json?: boolean },
  deps: SashUpgradeDeps,
  context: RuntimeContext,
): Promise<Error> {
  const reason = errorMessage(error);
  if (!previousVersion) {
    return new Error(`the new Sash did not become healthy: ${reason}`, { cause: error });
  }
  try {
    await (deps.install ?? runNpmInstall)(installation, previousVersion, options);
    await (deps.start ?? ensureDaemonSession)(context);
    return new Error(
      `the upgraded Sash did not start: ${reason} — rolled back to Sash ${previousVersion}`,
      { cause: error },
    );
  } catch (rollbackError) {
    return new Error(
      `the upgraded Sash did not start: ${reason} — the rollback to Sash ${previousVersion} also failed: ${errorMessage(rollbackError)}; reinstall it manually: npm install -g ${SASH_PACKAGE_NAME}@${previousVersion}`,
      { cause: error },
    );
  }
}

async function repairStaleAutostart(
  owner: HealthyDaemonSession,
  layout: SashLayout,
  deps: SashUpgradeDeps,
): Promise<boolean> {
  try {
    const autostart = deps.inspectAutostart
      ? await deps.inspectAutostart()
      : await new AutostartService({ layout }).inspect();
    if (autostart.state !== "stale") return false;
    await owner.client.setAutostart(true);
    return true;
  } catch {
    return false;
  }
}
