import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageCore } from "./core.js";
import { evaluateDaemon, prepareDaemonMaintenance } from "./daemon-lifecycle.js";
import { downloadReleaseAsset, listReleaseAssets } from "./github.js";
import { isPlainObject } from "./json-shape.js";
import { log } from "./log.js";
import type { RuntimeContext } from "./offline-mutation.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { buildSanitizedEnv } from "./process.js";
import { SashApiError } from "./sash-client.js";
import {
  findServiceHelper,
  parseServiceStatus,
  queryServiceState,
  requireActiveService,
  runServiceHelper,
  type ServiceStatus,
  trustedWindowsSystemExecutable,
} from "./service-client.js";
import { loadSettings } from "./settings.js";
import { withStateLock } from "./state-lock.js";
import { CoreSupervisor } from "./supervisor.js";
import { disableLegacySystemProxyIfOwned } from "./sysproxy.js";
import { SystemProxyManager } from "./system-proxy-manager.js";

export interface ServiceManagementStatus {
  supported: boolean;
  state: "not-installed" | "ready" | "unavailable" | "incompatible" | "root-mismatch";
  version?: string;
  coreVersion?: string;
  message?: string;
}

/** All external effects can be replaced in isolated tests; production never elevates itself. */
export interface ServiceManagementDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  packageVersion?: string;
  findHelper?: typeof findServiceHelper;
  queryState?: typeof queryServiceState;
  runHelper?: typeof runServiceHelper;
  bootstrapPrivileges?: (root: string) => unknown;
  listAssets?: typeof listReleaseAssets;
  downloadAsset?: typeof downloadReleaseAsset;
  stageCore?: typeof stageCore;
  maintenance?: typeof prepareDaemonMaintenance;
  evaluateDaemon?: typeof evaluateDaemon;
  loadSettings?: typeof loadSettings;
  releaseProxy?: (ctx: RuntimeContext, legacy: boolean) => Promise<void>;
  cleanDirectCore?: (ctx: RuntimeContext) => Promise<void>;
  withLock?: <T>(
    file: string,
    options: { purpose: string; timeoutMs: number },
    action: () => T | Promise<T>,
  ) => Promise<T>;
  tempRoot?: string;
  knownProgramFiles?: () => string;
  localHelper?: () => string | undefined;
}

function packageVersion(deps: ServiceManagementDeps): string {
  if (deps.packageVersion) return deps.packageVersion;
  const value: unknown = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (!isPlainObject(value) || typeof value.version !== "string")
    throw new Error("Invalid Sash package version");
  return value.version;
}

function bootstrapPrivileges(root: string): unknown {
  // No user-controlled shell interpolation, PATH lookup, profile, or auto-UAC.
  const encoded = Buffer.from(root, "utf8").toString("base64");
  const script = `$ErrorActionPreference='Stop'; $r=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $i=[Security.Principal.WindowsIdentity]::GetCurrent(); $p=[Security.Principal.WindowsPrincipal]::new($i); $o=(Get-Acl -LiteralPath $r).GetOwner([Security.Principal.SecurityIdentifier]); @{elevated=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); ownerMatches=($o.Value -eq $i.User.Value)} | ConvertTo-Json -Compress`;
  return JSON.parse(
    execFileSync(
      trustedWindowsSystemExecutable("WindowsPowerShell\\v1.0\\powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        encoding: "utf8",
        env: buildSanitizedEnv(),
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 16384,
      },
    ),
  );
}

function knownProgramFiles(): string {
  const folder = execFileSync(
    trustedWindowsSystemExecutable("WindowsPowerShell/v1.0/powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::Write([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles))",
    ],
    {
      encoding: "utf8",
      env: buildSanitizedEnv(),
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 16384,
    },
  ).trim();
  if (!path.isAbsolute(folder)) throw new Error("Cannot resolve trusted Program Files");
  return fs.realpathSync(folder);
}

function verifyRegular(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Helper must be a regular non-link file");
}

function cleanup(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    log.warn(
      `Could not remove service staging directory: ${directory}; remove it administratively after all helpers exit.`,
    );
  }
}

function cleanupProtectedStage(stage: { directory: string; stat: fs.Stats }): void {
  // The installed source may have been removed by uninstall. Delete only the
  // newly observed directory and its fixed file, never recursively walk it.
  const { directory, stat } = stage;
  try {
    const current = fs.lstatSync(directory);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.ino !== stat.ino ||
      current.dev !== stat.dev ||
      fs.realpathSync(directory).toLowerCase() !== directory.toLowerCase()
    )
      throw new Error("Maintenance directory identity changed");
    const entries = fs.readdirSync(directory);
    if (entries.some((entry) => entry !== "sash-service.exe"))
      throw new Error("Unknown maintenance directory contents");
    if (entries.length) {
      const file = path.join(directory, "sash-service.exe");
      verifyRegular(file);
      fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
  } catch {
    log.warn(
      `Could not remove service staging directory: ${directory}; remove it administratively after all helpers exit.`,
    );
  }
}

function requirePrivileges(value: unknown): void {
  if (!isPlainObject(value) || value.elevated !== true || value.ownerMatches !== true)
    throw new Error(
      "Use an Administrator PowerShell elevated as the same Windows user who owns SASH_HOME; alternate administrator credentials are not supported.",
    );
}

function checkRoot(status: ServiceStatus, root: string): void {
  if (
    status.installed &&
    (typeof status.root !== "string" ||
      !path.isAbsolute(status.root) ||
      status.root.toLowerCase() !== root.toLowerCase())
  )
    throw new SashApiError(
      409,
      "ROOT_MISMATCH",
      "Sash Service belongs to a different root; use its enrolled SASH_HOME.",
    );
}

export async function serviceStatus(
  layout: SashLayout,
  deps: ServiceManagementDeps = {},
): Promise<ServiceManagementStatus> {
  if ((deps.platform ?? process.platform) !== "win32")
    return {
      supported: false,
      state: "not-installed",
      message: "Sash Service is supported only on Windows.",
    };
  try {
    const registration = (deps.queryState ?? queryServiceState)();
    const helper = (deps.findHelper ?? findServiceHelper)();
    if (!helper)
      return registration === "absent"
        ? { supported: true, state: "not-installed" }
        : {
            supported: true,
            state: "unavailable",
            message: "Sash Service requires administrative repair.",
          };
    const root = fs.realpathSync(layout.root);
    const status = parseServiceStatus(
      await (deps.runHelper ?? runServiceHelper)(helper, ["status", "--root", root]),
    );
    checkRoot(status, root);
    if (!status.supported) throw new Error("Unsupported service status");
    if (!status.installed && registration !== "absent") throw new Error("Conflicting registration");
    const versions = {
      ...(status.version && /^[0-9A-Za-z.+-]{1,80}$/.test(status.version)
        ? { version: status.version }
        : {}),
      ...(status.coreVersion && /^[0-9A-Za-z.+-]{1,80}$/.test(status.coreVersion)
        ? { coreVersion: status.coreVersion }
        : {}),
    };
    return {
      supported: true,
      ...versions,
      state: !status.installed
        ? "not-installed"
        : status.protocol !== 1 || status.compatible !== true
          ? "incompatible"
          : status.running && registration === "running" && versions.version && versions.coreVersion
            ? "ready"
            : "unavailable",
    };
  } catch (error) {
    const code = error instanceof SashApiError ? error.code : undefined;
    const state =
      code === "ROOT_MISMATCH" || code === "OWNER_MISMATCH" || code === "ROOT_CONFLICT"
        ? "root-mismatch"
        : code === "INCOMPATIBLE" || code === "PROTOCOL_MISMATCH" || code === "VERSION_MISMATCH"
          ? "incompatible"
          : "unavailable";
    return {
      supported: true,
      state,
      message:
        state === "root-mismatch"
          ? "Sash Service belongs to a different root or Windows user."
          : state === "incompatible"
            ? "Sash Service is incompatible; administrative repair is required."
            : "Sash Service could not be verified; administrative repair may be required.",
    };
  }
}

async function manage(
  ctx: RuntimeContext,
  operation: "install" | "update" | "uninstall",
  opts: { coreVersion?: string; helperPath?: string },
  deps: ServiceManagementDeps,
): Promise<void> {
  if ((deps.platform ?? process.platform) !== "win32")
    throw new Error("Sash Service management is supported only on Windows.");
  const root = fs.realpathSync(ctx.layout.root);
  // This preflight precedes even temporary files, lock creation and downloads.
  requirePrivileges((deps.bootstrapPrivileges ?? bootstrapPrivileges)(root));
  const run = deps.runHelper ?? runServiceHelper;
  const version = packageVersion(deps);
  let temporary: string | undefined;
  try {
    const orphanRecovery = (error: unknown): boolean =>
      operation === "install" &&
      error instanceof SashApiError &&
      error.code === "RECOVERY_REQUIRED" &&
      (deps.queryState ?? queryServiceState)() === "absent";
    let helper: string | undefined;
    try {
      helper = opts.helperPath
        ? fs.realpathSync(opts.helperPath)
        : (deps.findHelper ?? findServiceHelper)();
    } catch (error) {
      if (!orphanRecovery(error)) throw error;
    }
    const matches = async (candidate: string): Promise<boolean> => {
      const identity = await run(candidate, ["version"]);
      return isPlainObject(identity) && identity.protocol === 1 && identity.version === version;
    };
    let matching = helper ? await matches(helper) : false;
    if (!matching && opts.helperPath)
      throw new Error(
        "Sash Service helper version/protocol does not match this Sash package; rebuild with `npm run build:service`.",
      );
    if (!matching) {
      const arch = deps.arch ?? process.arch;
      if (arch !== "x64" && arch !== "arm64")
        throw new Error("Unsupported Windows service architecture");
      const local = deps.localHelper
        ? deps.localHelper()
        : fileURLToPath(
            new URL(
              `../.native/windows-${arch === "x64" ? "amd64" : "arm64"}/sash-service.exe`,
              import.meta.url,
            ),
          );
      if (local && fs.existsSync(local)) {
        verifyRegular(local);
        if (await matches(local)) {
          helper = local;
          matching = true;
        }
      }
      if (!matching) {
        temporary = fs.mkdtempSync(path.join(deps.tempRoot ?? os.tmpdir(), "sash-service-"));
        fs.chmodSync(temporary, 0o700);
        helper = path.join(temporary, "sash-service.exe");
        try {
          const repo = "ming-kang/Sash";
          const tag = `v${version}`;
          await (deps.downloadAsset ?? downloadReleaseAsset)({
            repo,
            tag,
            assets: await (deps.listAssets ?? listReleaseAssets)(repo, tag),
            candidates: [`sash-service-windows-${arch === "x64" ? "amd64" : "arm64"}.exe`],
            dest: helper,
          });
          fs.chmodSync(helper, 0o600);
          verifyRegular(helper);
        } catch {
          throw new Error(
            `No verified Sash Service artifact is available for v${version}; build locally with \`npm run build:service\` and pass its path with --helper from the same user's Administrator PowerShell.`,
          );
        }
        matching = await matches(helper);
      }
    }
    if (!helper || !matching)
      throw new Error(
        "Sash Service helper version/protocol does not match this Sash package; rebuild with `npm run build:service`.",
      );
    requirePrivileges(await run(helper, ["privileges", "--root", root]));
    const selectedHelper = helper;
    await (deps.withLock ?? withStateLock)(
      ctx.layout.runtimeOperationLockFile,
      { purpose: `${operation} Sash Service`, timeoutMs: 180000 },
      async () => {
        const registration = (deps.queryState ?? queryServiceState)();
        let status: ServiceStatus | undefined;
        try {
          status = parseServiceStatus(await run(selectedHelper, ["status", "--root", root]));
          checkRoot(status, root);
        } catch (error) {
          if (!orphanRecovery(error) || registration !== "absent") throw error;
        }
        if (
          status &&
          ((!status.installed && registration !== "absent") ||
            (status.installed && registration === "absent"))
        )
          throw new Error(
            "Sash Service registration is inconsistent; repair its protected registration before retrying.",
          );
        if (operation !== "install" && !status?.installed)
          throw new Error("Sash Service is not installed.");
        if (status?.installed && (status.protocol !== 1 || status.compatible !== true))
          throw new Error("Sash Service is incompatible; repair is required.");
        // A stopped SCM service may still expose its approved version through native status.
        if (
          operation === "install" &&
          status?.installed &&
          !opts.coreVersion &&
          !status.coreVersion
        )
          throw new Error(
            "Cannot determine the protected approved Core version; specify --core-version explicitly.",
          );
        let staging: string | undefined;
        let protectedStage: { directory: string; stat: fs.Stats } | undefined;
        try {
          const programFiles = fs.realpathSync((deps.knownProgramFiles ?? knownProgramFiles)());
          const existing = new Set(fs.readdirSync(programFiles).map((name) => name.toLowerCase()));
          const copy = await run(selectedHelper, ["stage-maintenance", "--root", root]);
          if (
            !isPlainObject(copy) ||
            copy.protocol !== 1 ||
            typeof copy.helperPath !== "string" ||
            typeof copy.directory !== "string" ||
            !path.isAbsolute(copy.helperPath) ||
            !path.isAbsolute(copy.directory) ||
            path.basename(copy.helperPath) !== "sash-service.exe" ||
            path.dirname(copy.helperPath) !== copy.directory ||
            path.dirname(copy.directory).toLowerCase() !== programFiles.toLowerCase() ||
            !/^SashService-maintenance-[0-9a-f]{64}$/.test(path.basename(copy.directory)) ||
            existing.has(path.basename(copy.directory).toLowerCase())
          )
            throw new Error("Invalid protected maintenance stage path");
          const directoryStat = fs.lstatSync(copy.directory);
          if (
            !directoryStat.isDirectory() ||
            directoryStat.isSymbolicLink() ||
            fs.realpathSync(copy.directory).toLowerCase() !== copy.directory.toLowerCase()
          )
            throw new Error("Invalid protected maintenance stage directory");
          protectedStage = { directory: copy.directory, stat: directoryStat };
          const maintenanceHelper = copy.helperPath;
          verifyRegular(copy.helperPath);
          if (!(await matches(copy.helperPath)))
            throw new Error("Maintenance helper version/protocol mismatch");
          requirePrivileges(await run(copy.helperPath, ["privileges", "--root", root]));
          const repairing = status === undefined;
          const stagedRaw = await run(copy.helperPath, [
            repairing ? "repair-status" : "status",
            "--root",
            root,
          ]);
          const stagedStatus = parseServiceStatus(stagedRaw);
          checkRoot(stagedStatus, root);
          if (
            repairing &&
            (!isPlainObject(stagedRaw) ||
              stagedStatus.supported !== true ||
              stagedStatus.installed !== false ||
              stagedStatus.running !== false ||
              stagedStatus.root?.toLowerCase() !== root.toLowerCase() ||
              stagedStatus.version !== version ||
              "core" in stagedRaw ||
              "generation" in stagedRaw ||
              "serviceInstance" in stagedRaw ||
              (deps.queryState ?? queryServiceState)() !== "absent")
          )
            throw new Error("Invalid orphaned-install repair metadata");
          if (
            (status && stagedStatus.installed !== status.installed) ||
            stagedStatus.protocol !== 1 ||
            stagedStatus.compatible !== true
          )
            throw new Error("Maintenance helper status conflicts with selected helper");
          status = stagedStatus;
          let staged: Awaited<ReturnType<typeof stageCore>> | undefined;
          if (operation !== "uninstall") {
            staging = fs.mkdtempSync(path.join(deps.tempRoot ?? os.tmpdir(), "sash-service-core-"));
            fs.chmodSync(staging, 0o700);
            const target =
              opts.coreVersion ?? (operation === "install" ? status.coreVersion : undefined);
            staged = await (deps.stageCore ?? stageCore)({
              layout: sashLayout(staging),
              ...(target ? { tag: target } : {}),
            });
            fs.chmodSync(staged.exe, 0o600);
          }
          ctx.settings = (deps.loadSettings ?? loadSettings)(ctx.layout);
          // Restore only the already enrolled idle host before asking a live
          // daemon to retire its old-boot proof. Never replace approved bytes or
          // bypass failed graceful shutdown to make observation available.
          if (
            operation !== "uninstall" &&
            status.installed &&
            !status.running &&
            (await (deps.evaluateDaemon ?? evaluateDaemon)(ctx.layout, ctx.settings)).kind ===
              "healthy"
          ) {
            const idle = requireActiveService(
              await run(maintenanceHelper, ["start-service", "--root", root], 30000),
              ctx.layout,
            );
            if (idle.core.running)
              throw new Error("Administrative service recovery did not confirm idle Core");
          }
          let maintenance: Awaited<ReturnType<typeof prepareDaemonMaintenance>>;
          try {
            maintenance = await (deps.maintenance ?? prepareDaemonMaintenance)(
              ctx.layout,
              ctx.settings,
              "Sash Service management",
            );
          } catch {
            throw new Error(
              "sashd could not complete verified shutdown and proxy restoration. Repair or stop it as its owning user before retrying; SCM stop will not be forced.",
            );
          }
          await (deps.withLock ?? withStateLock)(
            ctx.layout.mutationLockFile,
            {
              purpose: "Sash Service administrative cutover",
              timeoutMs: 30000,
            },
            async () => {
              ctx.settings = (deps.loadSettings ?? loadSettings)(ctx.layout);
              if (
                (await (deps.evaluateDaemon ?? evaluateDaemon)(ctx.layout, ctx.settings)).kind !==
                "stopped"
              )
                throw new Error("sashd still owns this root; refusing administrative cutover.");
              await (
                deps.releaseProxy ??
                (async (current, legacy) => {
                  if (legacy && current.settings.systemProxy)
                    await disableLegacySystemProxyIfOwned({
                      port: current.settings.mixedPort,
                    });
                  await new SystemProxyManager({
                    layout: current.layout,
                  }).release();
                })
              )(ctx, maintenance.legacyDaemon);
              await (
                deps.cleanDirectCore ??
                (async (current) => {
                  await new CoreSupervisor({
                    layout: current.layout,
                    settings: () => current.settings,
                  }).cleanStaleCore();
                })
              )(ctx);
              // Native installer verifies SCM/job identity independently. No service IPC recovery
              // here: an unavailable service must not prevent safe administrative repair.
              if (operation !== "uninstall" && !staged) throw new Error("Missing staged Core");
              const result = await run(
                maintenanceHelper,
                !staged
                  ? ["uninstall", "--root", root]
                  : [
                      "install",
                      "--root",
                      root,
                      "--core",
                      staged.exe,
                      "--core-version",
                      staged.version,
                    ],
                120000,
              );
              if (
                !isPlainObject(result) ||
                result.protocol !== 1 ||
                result.installed !== (operation !== "uninstall")
              )
                throw new Error(
                  "Sash Service helper did not confirm the administrative operation.",
                );
            },
          );
        } finally {
          if (staging) cleanup(staging);
          if (protectedStage) cleanupProtectedStage(protectedStage);
        }
      },
    );
    log.info(
      operation === "uninstall"
        ? "Sash Service removed; user settings and desired TUN intent were preserved."
        : "Sash Service provisioned; Core rollback remains protected until a healthy managed start. Run `sash start` from a normal, non-administrator PowerShell.",
    );
  } finally {
    if (temporary) cleanup(temporary);
  }
}

export function installService(
  ctx: RuntimeContext,
  opts: { coreVersion?: string; helperPath?: string } = {},
  deps: ServiceManagementDeps = {},
): Promise<void> {
  return manage(ctx, "install", opts, deps);
}
export function uninstallService(
  ctx: RuntimeContext,
  deps: ServiceManagementDeps = {},
): Promise<void> {
  return manage(ctx, "uninstall", {}, deps);
}
export function updateServiceCore(
  ctx: RuntimeContext,
  opts: { version?: string } = {},
  deps: ServiceManagementDeps = {},
): Promise<void> {
  return manage(ctx, "update", { coreVersion: opts.version }, deps);
}
