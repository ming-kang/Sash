import path from "node:path";
import { isPlainObject } from "../json-shape.js";
import { findExecutableOnPath } from "../process.js";
import { type AutostartContext, requireCommandSuccess } from "./context.js";

// All interpolated launcher data travels through the environment, never PowerShell source.
const REGISTRY_SETUP = [
  "$ErrorActionPreference = 'Stop';",
  "$runPath = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';",
  "$approvalPath = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';",
  "$name = 'Sash';",
];

const INSPECT_SCRIPT = [
  ...REGISTRY_SETUP,
  "try {",
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runPath);",
  "$value = if ($key) { $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null };",
  "$run = if ($null -eq $value) { $null } elseif ($key.GetValueKind($name) -eq [Microsoft.Win32.RegistryValueKind]::String) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value)) } else { '' };",
  "if ($key) { $key.Dispose() };",
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($approvalPath);",
  "$value = if ($key) { $key.GetValue($name) } else { $null };",
  "$approval = if ($null -eq $value) { $null } elseif (($value -is [byte[]]) -and $value.Length -ge 12) { [Convert]::ToBase64String($value) } else { '' };",
  "if ($key) { $key.Dispose() };",
  "[Console]::Out.Write((ConvertTo-Json ([ordered]@{ run = $run; approval = $approval }) -Compress));",
  "} catch { [Console]::Error.Write($_.Exception.Message); exit 1 }",
].join(" ");

const SET_SCRIPT = [
  ...REGISTRY_SETUP,
  "$runKey = $null; $approvalKey = $null; $captured = $false;",
  "try {",
  "if ($env:SASH_AUTOSTART_MODE -notin @('on', 'off')) { throw 'Invalid autostart mode' };",
  "$runKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($runPath);",
  "$approvalKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($approvalPath, $true);",
  "$oldRun = $runKey.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);",
  "$oldRunKind = if ($null -ne $oldRun) { $runKey.GetValueKind($name) } else { $null };",
  "$oldApproval = if ($approvalKey) { $approvalKey.GetValue($name) } else { $null };",
  "$oldApprovalKind = if ($null -ne $oldApproval) { $approvalKey.GetValueKind($name) } else { $null };",
  "$captured = $true;",
  "if ($env:SASH_AUTOSTART_MODE -eq 'on') {",
  "  $runKey.SetValue($name, $env:SASH_AUTOSTART_COMMAND, [Microsoft.Win32.RegistryValueKind]::String);",
  "} else { $runKey.DeleteValue($name, $false) };",
  "if ($approvalKey) { $approvalKey.DeleteValue($name, $false) };",
  "} catch {",
  "$failure = $_.Exception.Message;",
  "if ($captured) { try {",
  "  if ($null -eq $oldRun) { $runKey.DeleteValue($name, $false) } else { $runKey.SetValue($name, $oldRun, $oldRunKind) };",
  "  if ($approvalKey) { if ($null -eq $oldApproval) { $approvalKey.DeleteValue($name, $false) } else { $approvalKey.SetValue($name, $oldApproval, $oldApprovalKind) } };",
  "} catch { $failure += '; registry rollback failed: ' + $_.Exception.Message } };",
  "[Console]::Error.Write($failure); exit 1;",
  "} finally { if ($runKey) { $runKey.Dispose() }; if ($approvalKey) { $approvalKey.Dispose() } }",
].join(" ");

export function windowsSystemPath(ctx: AutostartContext, executable: string): string {
  const root = ctx.env.SystemRoot?.trim() || ctx.env.WINDIR?.trim() || "C:\\Windows";
  if (!path.isAbsolute(root)) throw new Error("Windows system directory must be absolute");
  return path.join(root, "System32", executable);
}

async function runRegistryScript(
  ctx: AutostartContext,
  script: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const shell =
    findExecutableOnPath("pwsh.exe", ctx.env) ??
    windowsSystemPath(ctx, path.join("WindowsPowerShell", "v1.0", "powershell.exe"));
  const result = await ctx.run(
    shell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    env,
  );
  requireCommandSuccess(result);
  return result.stdout;
}

function nullableBase64(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && Buffer.from(value, "base64").toString("base64") === value)
  );
}

export async function readWindowsRegistration(
  ctx: AutostartContext,
): Promise<{ command: string | null; disabled: boolean }> {
  const value: unknown = JSON.parse(await runRegistryScript(ctx, INSPECT_SCRIPT));
  if (!isPlainObject(value) || !nullableBase64(value.run) || !nullableBase64(value.approval)) {
    throw new Error("Invalid Windows autostart registry response");
  }
  const approval = value.approval === null ? undefined : Buffer.from(value.approval, "base64");
  return {
    command: value.run === null ? null : Buffer.from(value.run, "base64").toString("utf8"),
    // Unknown/malformed StartupApproved values must never be reported as enabled.
    disabled:
      approval !== undefined && (approval.length < 12 || ![2, 6].includes(approval[0] ?? 0)),
  };
}

export async function setWindowsRegistration(
  ctx: AutostartContext,
  command: string | null,
): Promise<void> {
  await runRegistryScript(ctx, SET_SCRIPT, {
    SASH_AUTOSTART_MODE: command === null ? "off" : "on",
    SASH_AUTOSTART_COMMAND: command ?? "",
  });
}
