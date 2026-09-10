import path from "node:path";
import { isPlainObject } from "../json-shape.js";
import { findExecutableOnPath } from "../process.js";
import { type AutostartContext, requireCommandSuccess } from "./context.js";

const REGISTRY_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const REGISTRY_APPROVAL_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
const REGISTRY_VALUE_NAME = "Sash";

// All interpolated launcher data travels through the environment, never PowerShell source.
const REGISTRY_SETUP = [
  "$ErrorActionPreference = 'Stop';",
  "$runPath = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';",
  "$approvalPath = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';",
  "$name = 'Sash';",
];

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

// Fallback inspection for registry data that reg.exe cannot deliver losslessly:
// it writes raw OEM code page bytes to its pipe, so a start.vbs path under a
// non-ASCII user profile would decode to replacement characters. Base64 through
// PowerShell's .NET registry APIs is immune to the console code page.
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

export interface WindowsRegistryValue {
  type: string;
  data: string | Buffer;
}

function parseRegistryBinary(data: string): Buffer {
  if (!/^([0-9A-F]{2})*$/.test(data)) {
    throw new Error("Invalid Windows registry output: malformed REG_BINARY data");
  }
  return Buffer.from(data, "hex");
}

/**
 * Strictly parse one `reg.exe query <key> /v <name>` response. reg.exe echoes the
 * queried key as a header line (always with the full HKEY_CURRENT_USER hive name),
 * then each value as an indented line with four-space-separated name, type and data
 * fields. Anything else means the output does not answer our query.
 */
export function parseWindowsRegistryValue(
  output: string,
  keyPath: string,
  valueName: string,
): WindowsRegistryValue {
  const normalizeHeader = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/^hkcu\\/, "hkey_current_user\\");
  const lines = output.split(/\r\n?|\n/);
  let headerIndex = 0;
  while (headerIndex < lines.length && (lines[headerIndex] ?? "").trim().length === 0) {
    headerIndex++;
  }
  if (normalizeHeader(lines[headerIndex] ?? "") !== normalizeHeader(keyPath)) {
    throw new Error("Invalid Windows registry output: unexpected registry key header");
  }

  let found: WindowsRegistryValue | undefined;
  for (let index = headerIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      throw new Error("Invalid Windows registry output: unexpected line in registry response");
    }
    // The data field may itself contain spaces, so rejoin everything past the type.
    const [name, type, ...rest] = line.trimStart().split("    ");
    if (name !== valueName || !type || !/^REG_[A-Z0-9_]+$/.test(type)) {
      throw new Error("Invalid Windows registry output: unexpected line in registry response");
    }
    if (found) {
      throw new Error("Invalid Windows registry output: duplicate value in registry response");
    }
    const data = rest.join("    ");
    found = type === "REG_BINARY" ? { type, data: parseRegistryBinary(data) } : { type, data };
  }
  if (!found) {
    throw new Error("Invalid Windows registry output: missing queried value");
  }
  return found;
}

async function queryRegistrationValue(
  ctx: AutostartContext,
  key: string,
): Promise<WindowsRegistryValue | undefined> {
  const result = await ctx.run(windowsSystemPath(ctx, "reg.exe"), [
    "query",
    key,
    "/v",
    REGISTRY_VALUE_NAME,
  ]);
  // reg.exe exits 1 when the key or value is absent; its error text is localized,
  // so only the exit code distinguishes absence from a readable value.
  if (result.code !== 0) return undefined;
  return parseWindowsRegistryValue(result.stdout, key, REGISTRY_VALUE_NAME);
}

function nullableBase64(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && Buffer.from(value, "base64").toString("base64") === value)
  );
}

async function readWindowsRegistrationViaPowerShell(
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

function hasLossyData(value: WindowsRegistryValue | undefined): boolean {
  // A replacement character means the OEM bytes were not valid UTF-8; a question
  // mark means the console code page could not represent the character. Windows
  // paths cannot contain "?".
  return (
    typeof value?.data === "string" && (value.data.includes("\uFFFD") || value.data.includes("?"))
  );
}

export async function readWindowsRegistration(
  ctx: AutostartContext,
): Promise<{ command: string | null; disabled: boolean }> {
  const [run, approval] = await Promise.all([
    queryRegistrationValue(ctx, REGISTRY_RUN_KEY),
    queryRegistrationValue(ctx, REGISTRY_APPROVAL_KEY),
  ]);
  if (hasLossyData(run) || hasLossyData(approval)) return readWindowsRegistrationViaPowerShell(ctx);
  return {
    command:
      run === undefined
        ? null
        : run.type === "REG_SZ" && typeof run.data === "string"
          ? run.data
          : "",
    // Unknown/malformed StartupApproved values must never be reported as enabled.
    disabled:
      approval !== undefined &&
      (!Buffer.isBuffer(approval.data) ||
        approval.data.length < 12 ||
        ![2, 6].includes(approval.data[0] ?? 0)),
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
