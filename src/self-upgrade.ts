import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import semver from "semver";
import { readBoundedFile } from "./bounded-file.js";
import { errorMessage } from "./error-utils.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import {
  canonicalPath,
  type Installation,
  inspectInstallation,
  type NpmInstallation,
  npmPrefixForPackage,
  npmShimPaths,
  pathsEqual,
} from "./installation.js";
import { readSashPackageInfo, supportsNode, UPGRADE_PROTOCOL } from "./package-info.js";
import { upgradeChildEnv } from "./upgrade-command.js";
import { readPackageIdentity, readShimImage } from "./upgrade-files.js";
import { completedUpgradeArtifacts } from "./upgrade-garbage.js";
import { readPendingUpgrade, type UpgradeJournal, writeUpgradeJournal } from "./upgrade-journal.js";
import { copyUpgradeWorker, recoveryShimImages } from "./upgrade-launcher.js";
import { resolveSashNpmTarget, type SashNpmTarget } from "./upgrade-npm.js";
import { upgradePaths, upgradeTransactionPaths } from "./upgrade-paths.js";

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
  pending?: { from: string; target: string; phase: string };
}
export interface SashUpgradeInspection {
  report: SashUpgradeCheck;
  installation: Installation;
  target?: SashNpmTarget;
}

/** No locks, daemon startup or state initialization: --check is entirely observational. */
export async function inspectSashUpgrade(
  version?: string,
  options: { packageRoot?: string; nodeVersion?: string } = {},
): Promise<SashUpgradeInspection> {
  const observed = inspectInstallation({ packageRoot: options.packageRoot });
  const prefix = npmPrefixForPackage(observed.packageRoot);
  const pending = prefix ? readPendingUpgrade(canonicalPath(prefix)) : undefined;
  if (pending && !pathsEqual(canonicalPath(observed.packageRoot), pending.installation.packageRoot))
    throw new Error("Sash recovery journal belongs to a different package directory");
  // Native and recovery shims can coexist while Windows command entries are restored.
  const installation = pending?.installation ?? observed;
  const current = readSashPackageInfo(options.packageRoot).version;
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
  if (pending)
    return {
      installation,
      report: {
        ...base,
        prefix: installation.prefix,
        target: pending.targetVersion,
        pending: {
          from: pending.sourceVersion,
          target: pending.targetVersion,
          phase: pending.phase,
        },
        reason: "Recover the interrupted upgrade with sash upgrade",
      },
    };
  if (completedUpgradeArtifacts(installation).length)
    return {
      installation,
      report: {
        ...base,
        prefix: installation.prefix,
        target: current,
        pending: { from: current, target: current, phase: "cleanup" },
      },
    };
  const target = await resolveSashNpmTarget(version);
  const available =
    version !== undefined ? target.version !== current : semver.gt(target.version, current);
  const compatible =
    !available ||
    (supportsNode(target, nodeVersion) && target.upgradeProtocol === UPGRADE_PROTOCOL);
  const reason = !supportsNode(target, nodeVersion)
    ? `Sash ${target.version} requires Node ${target.nodeRange}`
    : target.upgradeProtocol !== UPGRADE_PROTOCOL
      ? `Sash ${target.version} does not support this runtime handoff protocol`
      : undefined;
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
      ...(available && reason ? { reason } : {}),
    },
  };
}

/** The worker holds the upgrade lock before calling this initializer. */
export function createSashUpgradeJournal(
  installation: NpmInstallation,
  targetVersion: string,
): UpgradeJournal {
  const global = upgradePaths(installation.prefix);
  for (const directory of [global.root, global.transactions]) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o755 });
    if (!fs.lstatSync(directory).isDirectory() || !pathsEqual(canonicalPath(directory), directory))
      throw new Error("Sash upgrade directory is linked or outside its installation");
  }
  const transactionId = crypto.randomBytes(16).toString("hex");
  const paths = upgradeTransactionPaths(installation.prefix, transactionId);
  const sourceVersion = readSashPackageInfo(installation.packageRoot).version;
  const source = readPackageIdentity(installation.packageRoot);
  const sourceShims = npmShimPaths(installation.prefix).map(readShimImage);
  fs.mkdirSync(paths.root, { mode: 0o700 });
  copyUpgradeWorker({ installation, transactionId });
  atomicWriteFileSync(
    paths.owner,
    `${JSON.stringify({ transactionId, installationId: installation.id, complete: false })}\n`,
  );
  const journal: UpgradeJournal = {
    format: 2,
    protocol: 1,
    transactionId,
    installation,
    sourceVersion,
    targetVersion,
    createdAt: new Date().toISOString(),
    phase: "preparing",
    source,
    candidate: null,
    sourceShims,
    candidateShims: null,
    recoveryShims: recoveryShimImages(),
    instances: [],
  };
  writeUpgradeJournal(journal);
  return journal;
}

/** Bootstrap outside the package before the worker takes its own installation lock. */
export async function executeSashUpgrade(
  installation: NpmInstallation,
  options: { version?: string; json?: boolean; recover?: boolean } = {},
): Promise<number> {
  const temporaryParent = canonicalPath(os.tmpdir());
  const pending = options.recover ? readPendingUpgrade(installation.prefix) : undefined;
  const source = pending
    ? upgradeTransactionPaths(installation.prefix, pending.transactionId).worker
    : path.join(installation.packageRoot, "dist", "upgrade-worker.mjs");
  const bytes = readBoundedFile(source, 16 * 1024 * 1024);
  const temporary = fs.mkdtempSync(path.join(temporaryParent, "sash-upgrade-bootstrap-"));
  fs.chmodSync(temporary, 0o700);
  const worker = path.join(temporary, "worker.mjs");
  atomicWriteFileSync(worker, bytes);
  const args = [
    worker,
    options.recover ? "--recover" : "--begin",
    installation.prefix,
    ...(options.version ? ["--target", options.version] : []),
    ...(options.json ? ["--json"] : []),
  ];
  let outcome: { code: number } | { error: unknown };
  try {
    const child = spawn(installation.nodePath, args, {
      cwd: installation.prefix,
      env: upgradeChildEnv(),
      windowsHide: true,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      shell: false,
    });
    const cancel = (): void => {
      if (child.connected) child.send({ type: "cancel" }, () => undefined);
    };
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    try {
      outcome = {
        code: await new Promise<number>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => resolve(code ?? 1));
        }),
      };
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  } catch (error) {
    outcome = { error };
  }
  try {
    if (!pathsEqual(path.dirname(canonicalPath(temporary)), temporaryParent))
      throw new Error("Sash bootstrap cleanup escaped its temporary directory");
    fs.unlinkSync(worker);
    fs.rmdirSync(temporary);
  } catch (error) {
    console.warn(`[sash upgrade] Temporary bootstrap files retained: ${errorMessage(error)}`);
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.code;
}
