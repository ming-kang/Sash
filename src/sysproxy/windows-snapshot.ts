import { isPlainObject } from "../json-shape.js";
import { findExecutableOnPath, windowsSystemExecutable } from "../process.js";
import { parseProxyEnable, parseProxyString, runCmd } from "./common.js";
import type { SystemProxySnapshot, WindowsSystemProxySnapshot } from "./types.js";

const MANAGED_KEYS = ["proxyEnable", "proxyServer", "proxyOverride", "autoConfigUrl"] as const;

/** Normalize an untrusted persisted snapshot before it can authorize a registry write. */
export function parseSystemProxySnapshot(value: unknown): WindowsSystemProxySnapshot {
  if (!isPlainObject(value) || value.version !== 1 || value.platform !== "win32") {
    throw new Error("Invalid system proxy snapshot: expected a version 1 Windows snapshot");
  }
  const ownKeys = Object.keys(value).sort();
  const expected = ["version", "platform", ...MANAGED_KEYS, "autoDetect"];
  const allowed = [...expected, "connections"];
  if (
    !expected.every((key) => ownKeys.includes(key)) ||
    !ownKeys.every((key) => allowed.includes(key))
  ) {
    throw new Error("Invalid system proxy snapshot: unexpected keys");
  }
  // Legacy v1 snapshots predate per-connection capture — treat a missing
  // field as an empty map so old journals still restore.
  const connections: Record<string, string> = {};
  if (value.connections !== undefined) {
    if (!isPlainObject(value.connections)) {
      throw new Error("Invalid system proxy snapshot: connections must be a name map");
    }
    for (const [name, hex] of Object.entries(value.connections)) {
      if (typeof hex !== "string" || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new Error("Invalid system proxy snapshot: connection values must be hex");
      }
      connections[name] = hex.toUpperCase();
    }
  }
  return {
    version: 1,
    platform: "win32",
    proxyEnable: parseProxyEnable(value.proxyEnable),
    proxyServer:
      value.proxyServer === null ? null : parseProxyString(value.proxyServer, "proxyServer"),
    proxyOverride:
      value.proxyOverride === null ? null : parseProxyString(value.proxyOverride, "proxyOverride"),
    autoConfigUrl:
      value.autoConfigUrl === null ? null : parseProxyString(value.autoConfigUrl, "autoConfigUrl"),
    autoDetect: parseProxyEnable(value.autoDetect),
    connections,
  };
}

/** WinINet PROXY_TYPE_* bits — the only flag bits that encode user intent. */
const CONNECTION_FLAG_MASK = 0x0f; // DIRECT | PROXY | AUTO_PROXY_URL | AUTO_DETECT

export interface ConnectionBlobSemantics {
  flags: number;
  proxyServer: string;
  proxyBypass: string;
  autoConfigUrl: string;
}

/**
 * INTERNET_PER_CONN_OPTION_LIST layout: u32 version, u32 write counter,
 * u32 flags, then three u32-length-prefixed ASCII strings — ProxyServer,
 * ProxyBypass, AutoConfigURL. Version/counter are WinINet-owned and
 * excluded — raw-byte compares false-positive on the per-refresh counter
 * bump. Unreadable blobs return null (unknown), never empty configuration.
 */
export function parseConnectionBlobSemantics(hex: string): ConnectionBlobSemantics | null {
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length < 12) return null;
  const flags = bytes.readUInt32LE(8) & CONNECTION_FLAG_MASK;
  let offset = 12;
  const strings: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    if (offset + 4 > bytes.length) return null;
    const len = bytes.readUInt32LE(offset);
    offset += 4;
    if (len > bytes.length - offset) return null;
    strings.push(bytes.subarray(offset, offset + len).toString("latin1"));
    offset += len;
  }
  return {
    flags,
    proxyServer: strings[0] ?? "",
    proxyBypass: strings[1] ?? "",
    autoConfigUrl: strings[2] ?? "",
  };
}

/** WinINet blob version observed on supported Windows releases. */
export const CONNECTION_BLOB_VERSION = 0x46;

export const LAN_CONNECTION_DEFAULT = "DefaultConnectionSettings";

/** Connection entries Sash owns: the LAN blobs, never named RAS/VPN entries. */
export const WIN_LAN_CONNECTIONS = new Set([LAN_CONNECTION_DEFAULT, "SavedLegacySettings"]);

/**
 * Serialize semantics in the INTERNET_PER_CONN_OPTION_LIST layout with a
 * standard header (version + zero counter — WinINet owns both). A
 * comparison/record value, never bytes to write: real WinINet blobs carry
 * tail bytes we cannot reproduce.
 */
export function serializeConnectionSemantics(sem: ConnectionBlobSemantics): string {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(CONNECTION_BLOB_VERSION, 0);
  head.writeUInt32LE(0, 4);
  const flags = Buffer.alloc(4);
  flags.writeUInt32LE(sem.flags & CONNECTION_FLAG_MASK, 0);
  const fields = [sem.proxyServer, sem.proxyBypass, sem.autoConfigUrl].map((text) => {
    const body = Buffer.from(text, "latin1");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(body.length, 0);
    return Buffer.concat([len, body]);
  });
  return Buffer.concat([head, flags, ...fields])
    .toString("hex")
    .toUpperCase();
}

/** Two blobs encode the same user configuration — ignoring version/counter bytes. */
export function blobsSemanticallyEqual(a: string, b: string): boolean {
  if (a.toUpperCase() === b.toUpperCase()) return true;
  const pa = parseConnectionBlobSemantics(a);
  const pb = parseConnectionBlobSemantics(b);
  if (pa === null || pb === null) return false; // unknown format ≠ equal
  return (
    pa.flags === pb.flags &&
    pa.proxyServer === pb.proxyServer &&
    pa.proxyBypass === pb.proxyBypass &&
    pa.autoConfigUrl === pb.autoConfigUrl
  );
}

/**
 * Connection maps match by name and user-visible semantics — an entry on
 * only one side, or semantically different, fails: a readback must never
 * adopt foreign changes.
 */
function connectionMapsEquivalent(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  const l = left ?? {};
  const r = right ?? {};
  const names = new Set([...Object.keys(l), ...Object.keys(r)]);
  for (const name of names) {
    const a = l[name];
    const b = r[name];
    if (a === undefined || b === undefined || !blobsSemanticallyEqual(a, b)) return false;
  }
  return true;
}

/** AutoDetect is observed but Windows owns it; never include it in managed comparisons. */
export function snapshotsEquivalent(
  left: SystemProxySnapshot,
  right: SystemProxySnapshot,
): boolean {
  return (
    left.platform === "win32" &&
    right.platform === "win32" &&
    MANAGED_KEYS.every((key) => left[key] === right[key]) &&
    connectionMapsEquivalent(left.connections, right.connections)
  );
}

export type CommandRunner = typeof runCmd;

/**
 * Default Windows runner: reg.exe is resolved to the System32 copy because
 * the sanitized environment may not carry a usable PATH. Injected runners
 * still see the logical name.
 */
export const runReg: CommandRunner = (command, args, timeoutMs) =>
  runCmd(
    command.toLowerCase() === "reg.exe" ? windowsSystemExecutable("reg.exe") : command,
    args,
    timeoutMs,
  );

export interface WindowsConnectionLine {
  name: string;
  type: string;
  data: string;
}

/** One `name TYPE data` value line from a `reg query` response; null for anything else. */
export function parseWindowsConnectionLine(line: string): WindowsConnectionLine | null {
  const match = line.match(/^\s+(.+?)\s+(REG_[A-Z0-9_]+)(?:\s+(.*?))?\s*$/i);
  const name = match?.[1]?.trim();
  if (!name || !match?.[2]) return null;
  return { name, type: match[2].toUpperCase(), data: match[3] ?? "" };
}

/**
 * Run a PowerShell script through each available shell, returning the first
 * result whose parse succeeds, or null when no shell can produce one.
 */
export async function runWindowsPowerShell<T>(
  run: CommandRunner,
  script: string,
  parse: (output: string) => T | null,
): Promise<T | null> {
  const shells = [
    () => findExecutableOnPath("pwsh.exe"),
    () => windowsSystemExecutable("WindowsPowerShell/v1.0/powershell.exe"),
  ];
  for (const resolveShell of shells) {
    try {
      const shell = resolveShell();
      if (!shell) continue;
      const parsed = parse(await run(shell, ["-NoProfile", "-NonInteractive", "-Command", script]));
      if (parsed !== null) return parsed;
    } catch {}
  }
  return null;
}

/**
 * The semantic target a LAN blob must reach after `apply`: PROXY set,
 * AUTO_PROXY_URL cleared, ProxyServer/ProxyBypass verbatim from the flat
 * values. DIRECT/AUTO_DETECT come from a parseable original, else a
 * standard fallback (AUTO_DETECT from the flat setting; a fresh blob may
 * add DIRECT). A comparison/journal value — version/counter stay
 * WinINet-owned — never bytes to write.
 */
export function buildExpectedLanBlob(
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
export function lanEffectiveMatch(
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
  return runWindowsPowerShell(run, script, (output) => {
    const parsed = JSON.parse(output.trim()) as {
      flags?: unknown;
      proxyServer?: unknown;
      proxyBypass?: unknown;
      autoConfigUrl?: unknown;
    };
    if (typeof parsed?.flags !== "number") return null;
    return {
      flags: parsed.flags & 0x0f,
      proxyServer: typeof parsed.proxyServer === "string" ? parsed.proxyServer : "",
      proxyBypass: typeof parsed.proxyBypass === "string" ? parsed.proxyBypass : "",
      autoConfigUrl: typeof parsed.autoConfigUrl === "string" ? parsed.autoConfigUrl : "",
    };
  });
}

/**
 * Prove every expected LAN blob after the WinINet refresh: a strict
 * semantic match passes; a parseable readback differing only in
 * environment-owned bits passes loosely and its proven semantics become
 * the target. A missing or unparseable DefaultConnectionSettings falls
 * back to InternetQueryOption; anything unproven fails the apply.
 */
export async function verifyWindowsLanConnections(
  target: WindowsSystemProxySnapshot,
  run: CommandRunner,
  capture: () => Promise<WindowsSystemProxySnapshot>,
): Promise<void> {
  // WinINet regenerates the LAN blobs asynchronously after refresh.
  let current = await capture();
  let stable = 0;
  for (let attempt = 0; attempt < 8 && stable < 2; attempt += 1) {
    const seen = JSON.stringify(current.connections);
    await new Promise((resolve) => setTimeout(resolve, 400));
    current = await capture();
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
