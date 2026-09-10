import os from "node:os";
import path from "node:path";
import { type AutostartOptions, autostartContext } from "../autostart/context.js";
import { readRegistration } from "../autostart/files.js";
import {
  parseWindowsLauncher,
  type WindowsLauncherTarget,
  windowsAutostart,
} from "../autostart/windows.js";
import { AutostartService } from "../autostart.js";
import { durableRemoveFileSync } from "../fs-atomic.js";
import { canonicalPath, npmPackageRoot, npmPrefixForPackage, pathsEqual } from "../installation.js";
import { installationRegistryPaths } from "../installation-registry.js";
import { hasExactOwnKeys, isPlainObject } from "../json-shape.js";
import { readSashPackageInfo, supportsNode } from "../package-info.js";
import { sashLayout } from "../paths.js";
import { readSignedFile, writeSignedFile } from "../signed-file.js";
import { authorizeInstallationUpgrade, type UpgradeAccess } from "../upgrade-access.js";
import { runUpgradeCommand } from "../upgrade-command.js";
import { upgradeTransactionPaths } from "../upgrade-paths.js";

interface LoginHandoff {
  transactionId: string;
  installationId: string;
  original: WindowsLauncherTarget | null;
  upgradeNodePath: string;
}

function handoffFile(access: UpgradeAccess): string {
  return path.join(installationRegistryPaths(access.installationId).root, "autostart-upgrade.json");
}

const AUTOSTART_ENVELOPE = {
  domain: "",
  maxBytes: 32 * 1024,
  subject: "login startup upgrade handoff",
} as const;

function writeHandoff(access: UpgradeAccess, payload: LoginHandoff): void {
  writeSignedFile(handoffFile(access), access.grant, payload, AUTOSTART_ENVELOPE);
}

function readHandoff(access: UpgradeAccess): LoginHandoff | undefined {
  const value = readSignedFile(handoffFile(access), access.grant, AUTOSTART_ENVELOPE);
  if (value === undefined) return undefined;
  if (
    !isPlainObject(value) ||
    !hasExactOwnKeys(value, ["transactionId", "installationId", "original", "upgradeNodePath"]) ||
    value.transactionId !== access.transactionId ||
    value.installationId !== access.installationId ||
    typeof value.upgradeNodePath !== "string" ||
    !path.isAbsolute(value.upgradeNodePath)
  )
    throw new Error("Login startup handoff belongs to another upgrade");
  const payload = value;
  if (
    !hasExactOwnKeys(payload, ["transactionId", "installationId", "original", "upgradeNodePath"]) ||
    payload.transactionId !== access.transactionId ||
    payload.installationId !== access.installationId ||
    typeof payload.upgradeNodePath !== "string" ||
    !path.isAbsolute(payload.upgradeNodePath)
  )
    throw new Error("Login startup handoff belongs to another upgrade");
  const original = payload.original;
  if (
    original !== null &&
    (!isPlainObject(original) ||
      !hasExactOwnKeys(original, ["nodePath", "entryPath", "dataDir"]) ||
      [original.nodePath, original.entryPath, original.dataDir].some(
        (value) => typeof value !== "string" || !path.isAbsolute(value),
      ))
  )
    throw new Error("Invalid login startup handoff paths");
  return {
    transactionId: access.transactionId,
    installationId: access.installationId,
    upgradeNodePath: payload.upgradeNodePath,
    original: original as WindowsLauncherTarget | null,
  };
}

/** A short-lived daemon writer handles login state without starting Core or creating sash.json. */
export async function runAutostartUpgrade(
  action: string,
  access: UpgradeAccess,
  packageRoot: string,
  options: Pick<AutostartOptions, "platform" | "env" | "runCommand"> & {
    nodeVersion?: (nodePath: string) => Promise<string>;
  } = {},
): Promise<void> {
  authorizeInstallationUpgrade(access);
  if (action === "capture") {
    if (readHandoff(access)) return;
    let original: WindowsLauncherTarget | null = null;
    let upgradeNodePath = canonicalPath(process.execPath);
    if ((options.platform ?? process.platform) === "win32") {
      const ctx = autostartContext({
        ...options,
        packageRoot,
        layout: sashLayout(path.join(os.tmpdir(), "sash-unused-startup-context")),
      });
      const target = parseWindowsLauncher(readRegistration(path.join(ctx.controlDir, "start.vbs")));
      let sameInstallation = false;
      if (target) {
        try {
          sameInstallation = pathsEqual(
            canonicalPath(target.entryPath),
            canonicalPath(ctx.entryPath),
          );
        } catch {
          /* An already broken or unrelated registration is not ours to repair. */
        }
      }
      if (
        target &&
        sameInstallation &&
        (await windowsAutostart({ ...ctx, ...target }).inspect()) === "on"
      ) {
        original = target;
        const prefix = npmPrefixForPackage(packageRoot);
        if (!prefix) throw new Error("Login startup upgrade requires a global npm installation");
        const staged = npmPackageRoot(upgradeTransactionPaths(prefix, access.transactionId).stage);
        const nodeVersion = options.nodeVersion
          ? await options.nodeVersion(target.nodePath)
          : (
              await runUpgradeCommand(target.nodePath, ["--version"], {
                cwd: packageRoot,
                purpose: "Check login startup Node compatibility",
              })
            ).trim();
        if (supportsNode(readSashPackageInfo(staged), nodeVersion))
          upgradeNodePath = target.nodePath;
      }
    }
    writeHandoff(access, {
      transactionId: access.transactionId,
      installationId: access.installationId,
      original,
      upgradeNodePath,
    });
    return;
  }
  const handoff = readHandoff(access);
  if (action === "cleanup") {
    if (handoff) durableRemoveFileSync(handoffFile(access));
    return;
  }
  if (!handoff) {
    if (action === "rollback") return;
    throw new Error("Login startup upgrade handoff is missing");
  }
  if (action !== "apply" && action !== "rollback")
    throw new Error("Invalid login startup upgrade action");
  if (!handoff.original) return;
  const original = handoff.original;
  const nodePath = action === "apply" ? handoff.upgradeNodePath : original.nodePath;
  const service = new AutostartService({
    ...options,
    packageRoot,
    layout: sashLayout(original.dataDir),
    nodePath,
  });
  const status = await service.repairAfterUpgrade([original.nodePath, handoff.upgradeNodePath]);
  if (status.state !== "on") throw new Error("Login startup did not survive the Sash upgrade");
}
