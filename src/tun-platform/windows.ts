import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { errorMessage } from "../error-utils.js";
import type { SashLayout } from "../paths.js";
import { runSanitizedCommandAsync, windowsSystemExecutable } from "../process.js";
import type { HostedCore, TunPlatform, TunPrivilege } from "../tun-service.js";
import {
  HELPER_PROTOCOL,
  type HelperReply,
  type HelperRequest,
  helperGuardUnsupportedWarning,
  requestHelper,
} from "./helper-pipe.js";
import { resolveHelperSource } from "./helper-source.js";
import type { WindowsGuardHost } from "./windows-guard.js";

export const HELPER_SERVICE = "SashTun";
/** The 0.7.0 helper service, replaced on install and removed on uninstall. */
const LEGACY_SERVICE = "SashTunHelper";

function samePath(left: string, right: string): boolean {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}

export function privilegeFromReply(reply: HelperReply, layout: SashLayout): TunPrivilege {
  if (reply.protocol > HELPER_PROTOCOL || reply.protocol < 1)
    return {
      state: "stale",
      detail: `the TUN service speaks protocol ${reply.protocol}; this Sash needs ${HELPER_PROTOCOL}`,
    };
  if (!samePath(reply.home, layout.root))
    return { state: "stale", detail: `the TUN service serves another data folder (${reply.home})` };
  return { state: "ready" };
}

export interface WindowsGuardStatus {
  /** False while a protocol-1 helper serves: it pre-dates the kill switch. */
  supported: boolean;
  active: boolean;
  device?: string;
  interfaceIndex?: number;
}

/** The kill switch picture a status reply carries, for doctor and status surfaces. */
export function guardFromReply(reply: HelperReply): WindowsGuardStatus {
  if (reply.protocol < HELPER_PROTOCOL) return { supported: false, active: false };
  return {
    supported: true,
    active: reply.guard?.active ?? false,
    ...(reply.guard?.device ? { device: reply.guard.device } : {}),
    ...(reply.guard?.interfaceIndex ? { interfaceIndex: reply.guard.interfaceIndex } : {}),
  };
}

export function guardSupportWarning(reply: HelperReply): string | null {
  return helperGuardUnsupportedWarning(reply);
}

/** CommandLineToArgvW quoting; arguments without spaces or quotes stay bare. */
export function quoteWindowsArgument(value: string): string {
  if (value && !/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)("|$)/g, (_match, slashes: string, quote: string) =>
    quote ? `${slashes}${slashes}\\"` : `${slashes}${slashes}`,
  )}"`;
}

/** Everything the service may ever run is fixed here, at installation. */
export function serviceArguments(layout: SashLayout, sid: string): string {
  return [
    "service",
    "--user",
    sid,
    "--core",
    layout.coreExe,
    "--home",
    layout.root,
    "--config",
    layout.configFile,
    "--stdout",
    layout.coreLogFile,
    "--stderr",
    layout.coreErrLogFile,
  ]
    .map(quoteWindowsArgument)
    .join(" ");
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The helper lives in an Administrators-owned directory under ProgramData:
 * ProgramData lets any user create folders, so an existing `Sash` folder is
 * taken over and re-protected rather than trusted.
 */
const SCRIPT_PRELUDE = `
$sashDir = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Sash'
$helperDir = Join-Path $sashDir 'TUN'
$helperExe = Join-Path $helperDir 'sash-tun-helper.exe'
$legacyDir = Join-Path $sashDir 'core'
function Remove-SashService([string]$name) {
  $service = Get-Service -Name $name -ErrorAction SilentlyContinue
  if (-not $service) { return }
  if ($service.Status -ne 'Stopped') {
    Stop-Service -Name $name -Force
    $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
  }
  $service.Close()
  & sc.exe delete $name | Out-Null
  for ($i = 0; $i -lt 50 -and (Get-Service -Name $name -ErrorAction SilentlyContinue); $i++) {
    Start-Sleep -Milliseconds 200
  }
  if (Get-Service -Name $name -ErrorAction SilentlyContinue) { throw "Windows did not remove the $name service" }
}
function Protect-Directory([string]$dir) {
  if (Test-Path -LiteralPath $dir) {
    $item = Get-Item -LiteralPath $dir -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "$dir is not a plain directory"
    }
  } else {
    New-Item -ItemType Directory -Path $dir | Out-Null
  }
  & icacls.exe $dir /setowner '*S-1-5-32-544' /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls could not take ownership of $dir" }
  & icacls.exe $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls could not protect $dir" }
}
Remove-SashService '${HELPER_SERVICE}'
Remove-SashService '${LEGACY_SERVICE}'
if (Test-Path -LiteralPath $legacyDir) { Remove-Item -LiteralPath $legacyDir -Recurse -Force }
`;

export function installScript(input: {
  source: string;
  sha256: string;
  arguments: string;
}): string {
  return `${SCRIPT_PRELUDE}
foreach ($dir in @($sashDir, $helperDir)) { Protect-Directory $dir }
Copy-Item -LiteralPath ${psQuote(input.source)} -Destination $helperExe -Force
$actual = (Get-FileHash -LiteralPath $helperExe -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne ${psQuote(input.sha256)}) {
  Remove-Item -LiteralPath $helperExe -Force
  throw "TUN helper digest mismatch: got $actual"
}
New-Service -Name '${HELPER_SERVICE}' -BinaryPathName ('"' + $helperExe + '" ' + ${psQuote(input.arguments)}) -DisplayName 'Sash TUN Helper' -Description 'Starts and stops the Sash Core with the privileges TUN Mode needs.' -StartupType Automatic | Out-Null
& sc.exe failure '${HELPER_SERVICE}' reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
Start-Service -Name '${HELPER_SERVICE}'
`;
}

export function uninstallScript(): string {
  return `${SCRIPT_PRELUDE}
if (Test-Path -LiteralPath $helperDir) { Remove-Item -LiteralPath $helperDir -Recurse -Force }
if ((Test-Path -LiteralPath $sashDir) -and -not (Get-ChildItem -LiteralPath $sashDir -Force)) {
  Remove-Item -LiteralPath $sashDir -Force
}
`;
}

function powershellExe(): string {
  return windowsSystemExecutable(path.join("WindowsPowerShell", "v1.0", "powershell.exe"));
}

async function runElevated(script: string, action: string): Promise<void> {
  const resultFile = path.join(
    os.tmpdir(),
    `sash-tun-${process.pid}-${randomBytes(6).toString("hex")}.txt`,
  );
  const elevated = `$ErrorActionPreference = 'Stop'
try {
${script}
} catch {
  Set-Content -LiteralPath ${psQuote(resultFile)} -Value $_.Exception.Message -Encoding UTF8
  exit 1
}`;
  const encoded = Buffer.from(elevated, "utf16le").toString("base64");
  const launcher =
    "$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden " +
    `-ArgumentList ${psQuote(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`)}; ` +
    "exit $p.ExitCode";
  try {
    await runSanitizedCommandAsync(
      powershellExe(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", launcher],
      { timeoutMs: 300_000 },
    );
  } catch (error) {
    const reason = (await fs.readFile(resultFile, "utf8").catch(() => "")).trim();
    if (reason) throw new Error(`Could not ${action}: ${reason}`);
    if (/cancel/i.test(errorMessage(error)))
      throw new Error("Windows administrator approval was cancelled");
    throw new Error(`Could not ${action}: ${errorMessage(error)}`);
  } finally {
    await fs.rm(resultFile, { force: true });
  }
}

async function currentUserSid(): Promise<string> {
  const output = await runSanitizedCommandAsync(windowsSystemExecutable("whoami.exe"), [
    "/user",
    "/fo",
    "csv",
    "/nh",
  ]);
  const sid = output.match(/"[^"]*","(S-1-[\d-]+)"/)?.[1];
  if (!sid) throw new Error("Could not read the current Windows account SID");
  return sid;
}

async function serviceRegistered(name: string): Promise<boolean> {
  try {
    await runSanitizedCommandAsync(windowsSystemExecutable("sc.exe"), ["query", name]);
    return true;
  } catch (error) {
    // ERROR_SERVICE_DOES_NOT_EXIST
    if ((error as { code?: unknown }).code === 1060) return false;
    throw error;
  }
}

export interface WindowsTunPlatformDeps {
  request?: HelperRequest;
  serviceRegistered?: (name: string) => Promise<boolean>;
  run?: (script: string, action: string) => Promise<void>;
  resolveSource?: typeof resolveHelperSource;
  userSid?: () => Promise<string>;
}

export function windowsTunPlatform(deps: WindowsTunPlatformDeps = {}): TunPlatform {
  const request =
    deps.request ?? ((op, timeoutMs, start) => requestHelper(op, timeoutMs, { start }));
  const registered = deps.serviceRegistered ?? serviceRegistered;
  const run = deps.run ?? runElevated;
  const resolveSource = deps.resolveSource ?? resolveHelperSource;
  const userSid = deps.userSid ?? currentUserSid;

  async function inspect(layout: SashLayout): Promise<TunPrivilege> {
    let reply: HelperReply;
    try {
      reply = await request("status", 5_000);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM")
        return { state: "stale", detail: "the TUN service belongs to another Windows account" };
      if (await registered(HELPER_SERVICE))
        return { state: "stale", detail: "the TUN service is installed but not running" };
      if (await registered(LEGACY_SERVICE))
        return { state: "stale", detail: "the TUN helper from Sash 0.7.0 must be replaced" };
      return { state: "missing" };
    }
    return privilegeFromReply(reply, layout);
  }

  return {
    mechanism: "service",
    inspect,
    async install(layout, options = {}) {
      const source = await resolveSource(layout, options);
      try {
        const sid = await userSid();
        await run(
          installScript({
            source: source.file,
            sha256: source.sha256,
            arguments: serviceArguments(layout, sid),
          }),
          "install the TUN helper",
        );
      } finally {
        await source.cleanup();
      }
      let privilege: TunPrivilege = { state: "unknown" };
      for (let attempt = 0; attempt < 30; attempt += 1) {
        privilege = await inspect(layout);
        if (privilege.state === "ready") return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(
        `The TUN service did not come up${privilege.detail ? `: ${privilege.detail}` : ""}`,
      );
    },
    async uninstall() {
      await run(uninstallScript(), "remove the TUN helper");
    },
    host(layout): HostedCore {
      const hosted: WindowsGuardHost = {
        async start(options) {
          const status = await request("status", 5_000);
          const privilege = privilegeFromReply(status, layout);
          if (privilege.state !== "ready")
            throw new Error(`The TUN service cannot start this Core: ${privilege.detail}`);
          const unsupported = guardSupportWarning(status);
          if (unsupported) console.warn(`[sashd] TUN kill switch unavailable: ${unsupported}`);
          const guarded = status.protocol >= HELPER_PROTOCOL;
          const reply = await request("start", 30_000, {
            guard: guarded,
            ...(options?.device ? { device: options.device } : {}),
          });
          if (!reply.ok || !reply.pid)
            throw new Error(reply.error ?? "The TUN service did not start the Core");
          return { pid: reply.pid };
        },
        async stop() {
          const reply = await request("stop", 30_000);
          if (!reply.ok) throw new Error(reply.error ?? "The TUN service did not stop the Core");
        },
        async unguard() {
          const reply = await request("unguard", 10_000);
          if (!reply.ok)
            throw new Error(reply.error ?? "The TUN service did not remove the TUN kill switch");
        },
        async status() {
          const reply = await request("status", 5_000);
          return { running: reply.running, pid: reply.pid ?? null };
        },
        async probeGuard() {
          return request("status", 5_000);
        },
      };
      return hosted;
    },
  };
}
