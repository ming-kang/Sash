import { findExecutableOnPath, windowsSystemExecutable } from "../process.js";
import { formatHostPort, normalizeEnableOptions, parseProxyString, runCmd } from "./common.js";
import {
  blobsSemanticallyEqual,
  type ConnectionBlobSemantics,
  LAN_CONNECTION_DEFAULT,
  parseConnectionBlobSemantics,
  serializeConnectionSemantics,
  WIN_LAN_CONNECTIONS,
} from "./snapshot.js";
import type {
  EnableOptions,
  SystemProxyBackend,
  SystemProxyRestoreResult,
  SystemProxyRestoreSkip,
  SystemProxySnapshot,
  SystemProxyState,
  WindowsRegistryProxyValues,
  WindowsSystemProxySnapshot,
} from "./types.js";
import { DEFAULT_BYPASS_LIST, SYSTEM_PROXY_SNAPSHOT_VERSION } from "./types.js";

const WIN_REG_PATH = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const WIN_CONNECTIONS_PATH = `${WIN_REG_PATH}\\Connections`;
const REGISTRY_HEADERS = new Set(
  [WIN_REG_PATH, WIN_REG_PATH.replace(/^HKCU/, "HKEY_CURRENT_USER")].map((header) =>
    header.toLowerCase(),
  ),
);
const MANAGED_VALUE_LINE =
  /^[^\S\r\n]*(ProxyEnable|ProxyServer|ProxyOverride|AutoConfigURL|AutoDetect)[^\S\r\n]+(REG_[A-Z0-9_]+)(?:[^\S\r\n]+(.*))?[^\S\r\n]*$/i;
const MANAGED_VALUE_PREFIX =
  /^[^\S\r\n]*(?:ProxyEnable|ProxyServer|ProxyOverride|AutoConfigURL|AutoDetect)(?:[^\S\r\n]|$)/i;
const GENERIC_REGISTRY_VALUE_LINE =
  /^[^\S\r\n]*.+?[^\S\r\n]+REG_[A-Z0-9_]+(?:[^\S\r\n]+.*)?[^\S\r\n]*$/i;

type WindowsValueName =
  | "ProxyEnable"
  | "ProxyServer"
  | "ProxyOverride"
  | "AutoConfigURL"
  | "AutoDetect";

export function formatWindowsBypass(list: string[] = DEFAULT_BYPASS_LIST): string {
  return list.join(";");
}

function emptyWindowsRegistryProxyValues(): WindowsRegistryProxyValues {
  return {
    proxyEnable: null,
    proxyServer: null,
    proxyOverride: null,
    autoConfigUrl: null,
    autoDetect: null,
  };
}

function setWindowsRegistryProxyValue(
  values: WindowsRegistryProxyValues,
  seen: Set<string>,
  name: string,
  type: string,
  rawValue: string,
): void {
  if (seen.has(name)) {
    throw new Error(`Invalid Windows registry output: duplicate ${name} value`);
  }
  seen.add(name);

  if (name === "proxyenable" || name === "autodetect") {
    if (type !== "REG_DWORD") {
      throw new Error(`Invalid Windows registry output: ${name} must be REG_DWORD`);
    }
    const text = rawValue.trim();
    if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(text)) {
      throw new Error(`Invalid Windows registry output: ${name} has an invalid DWORD value`);
    }
    const value = Number.parseInt(text, text.toLowerCase().startsWith("0x") ? 16 : 10);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new Error(`Invalid Windows registry output: ${name} is outside DWORD range`);
    }
    if (name === "proxyenable") values.proxyEnable = value;
    else values.autoDetect = value;
    return;
  }

  if (type !== "REG_SZ") {
    throw new Error(`Invalid Windows registry output: ${name} must be REG_SZ`);
  }
  const value = parseProxyString(rawValue.replace(/\r$/, ""), name);
  if (name === "proxyserver") {
    values.proxyServer = value;
  } else if (name === "proxyoverride") {
    values.proxyOverride = value;
  } else {
    values.autoConfigUrl = value;
  }
}

function parseManagedWindowsRegistryValue(
  line: string,
  values: WindowsRegistryProxyValues,
  seen: Set<string>,
): boolean {
  const match = line.match(MANAGED_VALUE_LINE);
  if (!match) return false;

  const name = match[1]?.toLowerCase();
  const type = match[2]?.toUpperCase();
  if (!name || !type) {
    throw new Error("Invalid Windows registry output: malformed managed value");
  }
  setWindowsRegistryProxyValue(values, seen, name, type, match[3] ?? "");
  return true;
}

/** Strict parse: a header plus at least one managed value, so truncated
 * output cannot become an all-null snapshot. */
export function parseWindowsRegistryProxyValues(output: string): WindowsRegistryProxyValues {
  const lines = output.split(/\r\n?|\n/);
  let headerIndex = 0;
  while (headerIndex < lines.length && (lines[headerIndex] ?? "").trim().length === 0) {
    headerIndex++;
  }
  if (!REGISTRY_HEADERS.has((lines[headerIndex] ?? "").trim().toLowerCase())) {
    throw new Error("Invalid Windows registry output: missing Internet Settings registry header");
  }

  const values = emptyWindowsRegistryProxyValues();
  const seen = new Set<string>();
  const headerText = (lines[headerIndex] ?? "").trim().toLowerCase();
  for (let index = headerIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      // `reg query` prints the queried key's subkey paths flush-left after its values.
      if (line.trim().toLowerCase().startsWith(`${headerText}\\`)) break;
      throw new Error("Invalid Windows registry output: unexpected line in registry response");
    }
    if (parseManagedWindowsRegistryValue(line, values, seen)) continue;
    if (MANAGED_VALUE_PREFIX.test(line)) {
      throw new Error("Invalid Windows registry output: malformed managed value");
    }
    if (!GENERIC_REGISTRY_VALUE_LINE.test(line)) {
      throw new Error("Invalid Windows registry output: unexpected line in registry response");
    }
  }
  if (seen.size === 0) {
    throw new Error("Invalid Windows registry output: missing managed proxy values");
  }
  return values;
}

type CommandRunner = typeof runCmd;

/**
 * Every value under `...\Internet Settings\Connections`: name → REG_BINARY
 * hex string — LAN blobs plus named RAS/VPN entries, kept verbatim so
 * restore is byte-exact.
 */
async function captureWindowsConnections(run: CommandRunner): Promise<Record<string, string>> {
  const connections: Record<string, string> = {};
  let output: string;
  try {
    output = await run("reg.exe", ["query", WIN_CONNECTIONS_PATH]);
  } catch {
    return connections; // Connections subkey may not exist yet.
  }
  for (const line of output.split(/\r\n?|\n/)) {
    const match = line.match(/^\s+(.+?)\s+REG_BINARY\s+([0-9a-fA-F]+)\s*$/);
    if (match?.[1] && match[2]) connections[match[1].trim()] = match[2].toUpperCase();
  }
  return connections;
}

export async function captureWindowsSnapshot(
  run: CommandRunner = runCmd,
): Promise<WindowsSystemProxySnapshot> {
  const values = parseWindowsRegistryProxyValues(await run("reg.exe", ["query", WIN_REG_PATH]));
  return {
    version: SYSTEM_PROXY_SNAPSHOT_VERSION,
    platform: "win32",
    proxyEnable: values.proxyEnable,
    proxyServer: values.proxyServer,
    proxyOverride: values.proxyOverride,
    autoConfigUrl: values.autoConfigUrl,
    autoDetect: values.autoDetect,
    connections: await captureWindowsConnections(run),
  };
}

async function refreshWindowsWinINet(run: CommandRunner): Promise<void> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$signature = @"',
    '[DllImport("wininet.dll", SetLastError = true)]',
    "public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);",
    '"@',
    "Add-Type -MemberDefinition $signature -Name WinINet -Namespace Interop",
    "foreach ($option in @(39, 37)) {",
    "  if (-not [Interop.WinINet]::InternetSetOption([IntPtr]::Zero, $option, [IntPtr]::Zero, 0)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }",
    "}",
  ].join("\n");
  const shells = [
    () => findExecutableOnPath("pwsh.exe"),
    () => windowsSystemExecutable("WindowsPowerShell/v1.0/powershell.exe"),
  ];
  for (const resolveShell of shells) {
    try {
      const shell = resolveShell();
      if (!shell) continue;
      await run(shell, ["-NoProfile", "-NonInteractive", "-Command", script]);
      return;
    } catch {}
  }
  try {
    console.warn(
      "[sash] WinINet notification is unavailable. Restart affected applications to pick up proxy registry changes, or install PowerShell for immediate notification.",
    );
  } catch {}
}

function windowsSnapshotValue(
  snapshot: WindowsSystemProxySnapshot,
  name: WindowsValueName,
): number | string | null {
  switch (name) {
    case "ProxyEnable":
      return snapshot.proxyEnable;
    case "ProxyServer":
      return snapshot.proxyServer;
    case "ProxyOverride":
      return snapshot.proxyOverride;
    case "AutoConfigURL":
      return snapshot.autoConfigUrl;
    case "AutoDetect":
      return snapshot.autoDetect;
  }
}

async function deleteWindowsValue(name: WindowsValueName, run: CommandRunner): Promise<void> {
  try {
    await run("reg.exe", ["delete", WIN_REG_PATH, "/v", name, "/f"]);
  } catch (err) {
    // A failed delete is harmless only when a fresh snapshot proves the
    // value absent — never infer absence from stderr.
    const current = await captureWindowsSnapshot(run);
    if (windowsSnapshotValue(current, name) !== null) throw err;
  }
}

async function applyWindowsValue(
  name: WindowsValueName,
  type: "REG_DWORD" | "REG_SZ",
  value: number | string | null,
  run: CommandRunner,
): Promise<void> {
  if (value === null) {
    await deleteWindowsValue(name, run);
    return;
  }
  await run("reg.exe", ["add", WIN_REG_PATH, "/v", name, "/t", type, "/d", String(value), "/f"]);
}

// Write ProxyEnable last; WinINet owns AutoDetect and regenerates the LAN blobs.
const WIN_PROXY_KEYS = [
  ["AutoConfigURL", "REG_SZ", "autoConfigUrl"],
  ["ProxyServer", "REG_SZ", "proxyServer"],
  ["ProxyOverride", "REG_SZ", "proxyOverride"],
  ["ProxyEnable", "REG_DWORD", "proxyEnable"],
] as const;

export async function applyWindowsSnapshot(
  snapshot: WindowsSystemProxySnapshot,
  run: CommandRunner = runCmd,
): Promise<void> {
  try {
    for (const [name, type, key] of WIN_PROXY_KEYS) {
      await applyWindowsValue(name, type, snapshot[key], run);
    }
  } finally {
    await refreshWindowsWinINet(run);
  }
  await verifyWindowsLanConnections(snapshot, run);
}

/**
 * Only revert Sash's own changes. Ignore WinINet's connection-blob counters
 * when comparing snapshots, but write the original bytes when restoring.
 */
export async function restoreWindowsSnapshot(
  original: WindowsSystemProxySnapshot,
  target: WindowsSystemProxySnapshot,
  run: CommandRunner = runCmd,
): Promise<SystemProxyRestoreResult> {
  const skipped: SystemProxyRestoreSkip[] = [];
  const current = await captureWindowsSnapshot(run);
  const writes: Array<
    [
      WindowsValueName,
      "REG_DWORD" | "REG_SZ",
      (typeof WIN_PROXY_KEYS)[number][2],
      number | string | null,
    ]
  > = [];
  for (const [regName, type, key] of WIN_PROXY_KEYS) {
    const cur = current[key];
    const orig = original[key];
    if (cur === orig) continue;
    if (cur === target[key]) writes.push([regName, type, key, orig]);
    else skipped.push({ key, service: "Internet Settings", reason: "modified" });
  }
  const blobTargetMatches = (name: string, cur: string, targetHex: string | undefined): boolean =>
    targetHex !== undefined &&
    (blobsSemanticallyEqual(cur, targetHex) ||
      // For LAN blobs the expected is a semantic intent, not a byte layout —
      // WinINet materializes it with its own DIRECT/AUTO_DETECT bits.
      (WIN_LAN_CONNECTIONS.has(name) &&
        lanEffectiveMatch(
          parseConnectionBlobSemantics(cur) ?? {
            flags: 0,
            proxyServer: "",
            proxyBypass: "",
            autoConfigUrl: "",
          },
          parseConnectionBlobSemantics(targetHex),
          target,
        )));
  const blobWrites: Array<{ name: string; hex: string; recheckAbsent: boolean }> = [];
  const writtenBlobs: Array<{ name: string; hex: string }> = [];
  for (const [name, hex] of Object.entries(original.connections)) {
    const cur = current.connections[name];
    const targetHex = target.connections?.[name];
    if (cur !== undefined && blobsSemanticallyEqual(cur, hex)) continue;
    if (cur !== undefined && blobTargetMatches(name, cur, targetHex)) {
      blobWrites.push({ name, hex, recheckAbsent: false });
    } else if (cur === undefined && WIN_LAN_CONNECTIONS.has(name)) {
      // A LAN blob WinINet has not regenerated yet — the recorded
      // original is the correct prior state; write it back.
      blobWrites.push({ name, hex, recheckAbsent: true });
    } else {
      skipped.push({
        key: name,
        service: `Connections\\${name}`,
        reason: cur === undefined ? "removed" : "modified",
      });
    }
  }
  try {
    for (const [name, type, , value] of writes) await applyWindowsValue(name, type, value, run);
    for (const { name, hex, recheckAbsent } of blobWrites) {
      if (recheckAbsent) {
        // Absent at capture — re-read just before writing so a blob that
        // materialized since is never overwritten with the recorded original.
        const latest = (await captureWindowsConnections(run))[name];
        if (latest !== undefined) {
          if (blobsSemanticallyEqual(latest, hex)) continue;
          if (!blobTargetMatches(name, latest, target.connections?.[name])) {
            skipped.push({
              key: name,
              service: `Connections\\${name}`,
              reason: "modified",
            });
            continue;
          }
        }
      }
      await run("reg.exe", [
        "add",
        WIN_CONNECTIONS_PATH,
        "/v",
        name,
        "/t",
        "REG_BINARY",
        "/d",
        hex,
        "/f",
      ]);
      writtenBlobs.push({ name, hex });
    }
  } finally {
    if (writes.length > 0 || writtenBlobs.length > 0) await refreshWindowsWinINet(run);
  }
  if (writes.length > 0 || writtenBlobs.length > 0) {
    // The refresh itself may rewrite blobs and flat keys — re-verify
    // against the restored values, polling while WinINet settles. What no
    // longer matches the original keeps the journal as evidence.
    const matches = (snap: WindowsSystemProxySnapshot) =>
      writes.every(([, , key]) => snap[key] === original[key]) &&
      writtenBlobs.every(({ name, hex }) => {
        const cur = snap.connections[name];
        return cur !== undefined && blobsSemanticallyEqual(cur, hex);
      });
    let after = await captureWindowsSnapshot(run);
    for (let attempt = 0; attempt < 8 && !matches(after); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      after = await captureWindowsSnapshot(run);
    }
    for (const [, , key] of writes) {
      if (after[key] !== original[key]) {
        skipped.push({ key, service: "Internet Settings", reason: "modified" });
      }
    }
    for (const { name, hex } of writtenBlobs) {
      const cur = after.connections[name];
      if (cur === undefined || !blobsSemanticallyEqual(cur, hex)) {
        skipped.push({ key: name, service: `Connections\\${name}`, reason: "modified" });
      }
    }
  }
  return { skipped };
}

/**
 * The semantic target a LAN blob must reach after `apply`: PROXY set,
 * AUTO_PROXY_URL cleared, ProxyServer/ProxyBypass verbatim from the flat
 * values. DIRECT/AUTO_DETECT come from a parseable original, else a
 * standard fallback (AUTO_DETECT from the flat setting; a fresh blob may
 * add DIRECT). A comparison/journal value — version/counter stay
 * WinINet-owned — never bytes to write.
 */
function buildExpectedLanBlob(
  originalHex: string | undefined,
  server: string,
  bypass: string,
  autoDetect: number | null,
): string {
  const semantics = originalHex === undefined ? null : parseConnectionBlobSemantics(originalHex);
  const flags =
    semantics === null ? 0x02 | (autoDetect === 1 ? 0x08 : 0) : (semantics.flags & ~0x04) | 0x02;
  return serializeConnectionSemantics({
    flags,
    proxyServer: server,
    proxyBypass: bypass,
    autoConfigUrl: "",
  });
}

/**
 * A readback (registry blob or InternetQueryOption result) proves the
 * applied LAN settings when PROXY is on, AUTO_PROXY_URL is off, the strings
 * match the flat intent, and AUTO_DETECT is on when the expected asserts
 * it. DIRECT is environment-owned and never checked; an expected
 * AUTO_DETECT-off is WinINet's claim-free bit and never fails the readback.
 */
function lanEffectiveMatch(
  actual: ConnectionBlobSemantics,
  expected: ConnectionBlobSemantics | null,
  target: WindowsSystemProxySnapshot,
): boolean {
  return (
    (actual.flags & 0x02) !== 0 &&
    (actual.flags & 0x04) === 0 &&
    (expected === null || (expected.flags & 0x08) === 0 || (actual.flags & 0x08) !== 0) &&
    actual.proxyServer === (target.proxyServer ?? "") &&
    actual.proxyBypass === (target.proxyOverride ?? "") &&
    actual.autoConfigUrl === (target.autoConfigUrl ?? "")
  );
}

/**
 * Effective LAN connection options via
 * InternetQueryOption(INTERNET_OPTION_PER_CONNECTION_OPTION) — the
 * supported source when the registry blob is absent or unreadable.
 */
async function queryLanEffectiveOptions(
  run: CommandRunner,
): Promise<ConnectionBlobSemantics | null> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$signature = @"',
    '[DllImport("wininet.dll", CharSet = CharSet.Ansi, SetLastError = true)]',
    "public static extern IntPtr InternetOpen(string agent, int access, string proxy, string bypass, int flags);",
    '[DllImport("wininet.dll", CharSet = CharSet.Ansi, SetLastError = true)]',
    "public static extern IntPtr InternetConnect(IntPtr hInternet, string server, short port, string user, string pass, int service, int flags, int ctx);",
    '[DllImport("wininet.dll", SetLastError = true)]',
    "public static extern bool InternetQueryOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, ref int lpdwBufferLength);",
    '[DllImport("wininet.dll", SetLastError = true)]',
    "public static extern bool InternetCloseHandle(IntPtr hInternet);",
    '"@',
    "Add-Type -MemberDefinition $signature -Name WinINetQuery -Namespace Interop",
    "$handle = [Interop.WinINetQuery]::InternetOpen('sash', 0, $null, $null, 0)",
    "if ($handle -eq [IntPtr]::Zero) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }",
    "# PER_CONNECTION_OPTION only answers on a connection handle — the root",
    "# handle returns inert DIRECT defaults regardless of the real settings.",
    "$conn = [Interop.WinINetQuery]::InternetConnect($handle, 'invalid.sash', 80, $null, $null, 3, 0, 0)",
    "if ($conn -eq [IntPtr]::Zero) { [Interop.WinINetQuery]::InternetCloseHandle($handle) | Out-Null; throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }",
    "$handle = $conn",
    "try {",
    "  $count = 4",
    "  $options = [Runtime.InteropServices.Marshal]::AllocHGlobal(16 * $count)",
    "  $strings = @()",
    "  try {",
    "    $optionIds = @(1, 2, 3, 4)",
    "    for ($i = 0; $i -lt $count; $i++) {",
    "      [Runtime.InteropServices.Marshal]::WriteInt32($options, 16 * $i, $optionIds[$i])",
    "      if ($optionIds[$i] -ne 1) {",
    "        $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal(2048)",
    "        $strings += $buf",
    "        [Runtime.InteropServices.Marshal]::WriteIntPtr($options, 16 * $i + 8, $buf)",
    "      }",
    "    }",
    "    $list = [Runtime.InteropServices.Marshal]::AllocHGlobal(32)",
    "    try {",
    "      [Runtime.InteropServices.Marshal]::WriteInt32($list, 0, 32)",
    "      [Runtime.InteropServices.Marshal]::WriteIntPtr($list, 8, [IntPtr]::Zero)",
    "      [Runtime.InteropServices.Marshal]::WriteInt32($list, 16, $count)",
    "      [Runtime.InteropServices.Marshal]::WriteInt32($list, 20, 0)",
    "      [Runtime.InteropServices.Marshal]::WriteIntPtr($list, 24, $options)",
    "      $length = 32",
    "      if (-not [Interop.WinINetQuery]::InternetQueryOption($handle, 75, $list, [ref]$length)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }",
    "      $read = { param($i) [Runtime.InteropServices.Marshal]::PtrToStringAnsi([Runtime.InteropServices.Marshal]::ReadIntPtr($options, 16 * $i + 8)) }",
    "      @{ flags = [Runtime.InteropServices.Marshal]::ReadInt32($options, 8); proxyServer = (& $read 1); proxyBypass = (& $read 2); autoConfigUrl = (& $read 3) } | ConvertTo-Json -Compress",
    "    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($list) }",
    "  } finally {",
    "    foreach ($buf in $strings) { [Runtime.InteropServices.Marshal]::FreeHGlobal($buf) }",
    "    [Runtime.InteropServices.Marshal]::FreeHGlobal($options)",
    "  }",
    "} finally { [Interop.WinINetQuery]::InternetCloseHandle($handle) | Out-Null }",
  ].join("\n");
  const shells = [
    () => findExecutableOnPath("pwsh.exe"),
    () => windowsSystemExecutable("WindowsPowerShell/v1.0/powershell.exe"),
  ];
  for (const resolveShell of shells) {
    try {
      const shell = resolveShell();
      if (!shell) continue;
      const output = await run(shell, ["-NoProfile", "-NonInteractive", "-Command", script]);
      const parsed = JSON.parse(output.trim()) as {
        flags?: unknown;
        proxyServer?: unknown;
        proxyBypass?: unknown;
        autoConfigUrl?: unknown;
      };
      if (typeof parsed?.flags !== "number") continue;
      return {
        flags: parsed.flags & 0x0f,
        proxyServer: typeof parsed.proxyServer === "string" ? parsed.proxyServer : "",
        proxyBypass: typeof parsed.proxyBypass === "string" ? parsed.proxyBypass : "",
        autoConfigUrl: typeof parsed.autoConfigUrl === "string" ? parsed.autoConfigUrl : "",
      };
    } catch {}
  }
  return null;
}

/**
 * Prove every expected LAN blob after the WinINet refresh: a strict
 * semantic match passes; a parseable readback differing only in
 * environment-owned bits passes loosely and its proven semantics become
 * the target. A missing or unparseable DefaultConnectionSettings falls
 * back to InternetQueryOption; anything unproven fails the apply.
 */
async function verifyWindowsLanConnections(
  target: WindowsSystemProxySnapshot,
  run: CommandRunner,
): Promise<void> {
  // WinINet regenerates the LAN blobs asynchronously after refresh.
  let current = await captureWindowsSnapshot(run);
  let stable = 0;
  for (let attempt = 0; attempt < 8 && stable < 2; attempt += 1) {
    const seen = JSON.stringify(current.connections);
    await new Promise((resolve) => setTimeout(resolve, 400));
    current = await captureWindowsSnapshot(run);
    stable = JSON.stringify(current.connections) === seen ? stable + 1 : 0;
  }
  const names = new Set([
    ...Object.keys(target.connections).filter((name) => WIN_LAN_CONNECTIONS.has(name)),
    ...Object.keys(current.connections).filter((name) => WIN_LAN_CONNECTIONS.has(name)),
    LAN_CONNECTION_DEFAULT,
  ]);
  const unresolved: string[] = [];
  for (const name of names) {
    const cur = current.connections[name];
    const expected = target.connections[name];
    if (cur === undefined && expected === undefined) continue;
    if (cur !== undefined && expected !== undefined && blobsSemanticallyEqual(cur, expected)) {
      continue;
    }
    const sem = cur === undefined ? null : parseConnectionBlobSemantics(cur);
    const expectedSem = expected === undefined ? null : parseConnectionBlobSemantics(expected);
    if (sem !== null && lanEffectiveMatch(sem, expectedSem, target)) {
      // Loose check passed: record the proven effective semantics — the
      // registry blob stays WinINet's own serialization, never adopted.
      target.connections[name] = serializeConnectionSemantics(sem);
      continue;
    }
    unresolved.push(name);
  }
  for (const name of unresolved) {
    if (name !== LAN_CONNECTION_DEFAULT) {
      // A LAN blob that never materialized cannot be proven by the
      // per-connection API — record the absence; a present-but-unverifiable
      // blob still fails the apply.
      if (current.connections[name] === undefined) {
        delete target.connections[name];
        continue;
      }
      throw new Error(`System proxy apply could not verify the "${name}" connection settings`);
    }
    const curHex = current.connections[name];
    if (curHex !== undefined && parseConnectionBlobSemantics(curHex) !== null) {
      // A parseable blob matching neither check is a semantic conflict —
      // the effective-settings API stands in only for a missing or
      // unparseable blob, never overrides a proven registry difference.
      throw new Error(`System proxy apply could not verify the "${name}" connection settings`);
    }
    const effective = await queryLanEffectiveOptions(run);
    const expectedSem = parseConnectionBlobSemantics(target.connections[name] ?? "");
    if (effective === null || !lanEffectiveMatch(effective, expectedSem, target)) {
      throw new Error("System proxy apply could not verify the effective LAN proxy settings");
    }
    // Proven through the supported API: normalize the target so the
    // post-apply equivalence check reflects what actually materialized.
    const cur = current.connections[name];
    if (cur === undefined) delete target.connections[name];
    else target.connections[name] = cur;
  }
}

export function createWindowsTarget(
  opts: EnableOptions,
  original?: SystemProxySnapshot,
): WindowsSystemProxySnapshot {
  const normalized = normalizeEnableOptions(opts);
  const proxyServer = formatHostPort(normalized.host, normalized.port);
  const proxyOverride = formatWindowsBypass(normalized.bypass);
  const connections: Record<string, string> = {};
  if (original?.platform === "win32") {
    for (const [name, hex] of Object.entries(original.connections)) {
      // LAN blobs are what Sash's apply changes; named (RAS/VPN) entries are
      // left untouched, so their expected value is the original itself.
      connections[name] = WIN_LAN_CONNECTIONS.has(name)
        ? buildExpectedLanBlob(hex, proxyServer, proxyOverride, original.autoDetect)
        : hex;
    }
    // An apply is unproven until the default LAN blob exists and matches —
    // expect one even when the original had none (apply drops it again if
    // only InternetQueryOption can prove the settings).
    if (original.connections[LAN_CONNECTION_DEFAULT] === undefined) {
      connections[LAN_CONNECTION_DEFAULT] = buildExpectedLanBlob(
        undefined,
        proxyServer,
        proxyOverride,
        original.autoDetect,
      );
    }
  }
  return {
    version: SYSTEM_PROXY_SNAPSHOT_VERSION,
    platform: "win32",
    proxyEnable: 1,
    proxyServer,
    proxyOverride,
    autoConfigUrl: null,
    // A manual proxy takes precedence over WPAD, and the flat AutoDetect value is
    // not durable across WinINet refreshes.
    autoDetect: null,
    // Semantic per-connection intent: prepared/crash recovery and
    // post-apply verification compare these by flags+strings, so a foreign
    // change is never absorbed as Sash-owned.
    connections,
  };
}

export function windowsState(snapshot: WindowsSystemProxySnapshot): SystemProxyState {
  const enabled = snapshot.proxyEnable === 1;
  if (enabled) {
    return snapshot.proxyServer
      ? { supported: true, enabled: true, server: snapshot.proxyServer }
      : { supported: true, enabled: true, details: "manual proxy has no server" };
  }
  if (snapshot.autoConfigUrl || snapshot.autoDetect === 1) {
    return {
      supported: true,
      enabled: true,
      ...(snapshot.autoConfigUrl ? { server: snapshot.autoConfigUrl } : {}),
      details: snapshot.autoConfigUrl
        ? "automatic proxy configuration is enabled"
        : "automatic proxy detection is enabled",
    };
  }
  return { supported: true, enabled: false };
}

export function asWindowsSnapshot(snapshot: SystemProxySnapshot): WindowsSystemProxySnapshot {
  if (snapshot.platform !== "win32") throw new Error("Expected a Windows system proxy snapshot");
  return snapshot;
}

export function windowsSystemProxyBackend(): SystemProxyBackend {
  return {
    supported: true,
    capture: captureWindowsSnapshot,
    apply: (snapshot) => applyWindowsSnapshot(asWindowsSnapshot(snapshot)),
    restore: (original, target) =>
      restoreWindowsSnapshot(asWindowsSnapshot(original), asWindowsSnapshot(target)),
  };
}
