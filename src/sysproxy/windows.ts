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
 * hex string. DefaultConnectionSettings/SavedLegacySettings are the default
 * connection's blobs; named entries are RAS/VPN connections. Each is kept
 * verbatim so restore is byte-exact.
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
    // A failed delete is harmless only when a fresh snapshot proves the value is
    // already absent; never infer absence from stderr.
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

export async function applyWindowsSnapshot(
  snapshot: WindowsSystemProxySnapshot,
  run: CommandRunner = runCmd,
): Promise<void> {
  try {
    // Disable/restore PAC metadata before enabling the manual proxy, and keep
    // ProxyEnable last so a partial write does not become active first. AutoDetect
    // is never written: Windows rewrites it from DefaultConnectionSettings on
    // every WinINet refresh.
    await applyWindowsValue("AutoConfigURL", "REG_SZ", snapshot.autoConfigUrl, run);
    await applyWindowsValue("ProxyServer", "REG_SZ", snapshot.proxyServer, run);
    await applyWindowsValue("ProxyOverride", "REG_SZ", snapshot.proxyOverride, run);
    await applyWindowsValue("ProxyEnable", "REG_DWORD", snapshot.proxyEnable, run);
    // Per-connection blobs are never written here: the flat keys carry the
    // intent and the WinINet refresh below regenerates the LAN blobs from
    // them. snapshot.connections holds semantic expectations for readback
    // verification and restore comparison only — writing the synthesized LAN
    // blobs would lose WinINet-owned tail bytes, and writing named RAS/VPN
    // blobs would overwrite another client's connection.
  } finally {
    await refreshWindowsWinINet(run);
  }
  // Apply succeeds only when every expected LAN blob is proven — a parseable
  // readback matching the semantic expectation, or the effective settings
  // from InternetQueryOption when the registry never materialized one.
  await verifyWindowsLanConnections(snapshot, run);
}

const WIN_RESTORE_KEYS = [
  ["AutoConfigURL", "REG_SZ", "autoConfigUrl"],
  ["ProxyServer", "REG_SZ", "proxyServer"],
  ["ProxyOverride", "REG_SZ", "proxyOverride"],
  ["ProxyEnable", "REG_DWORD", "proxyEnable"],
] as const;

/**
 * Journal-scoped restore: every field and every per-connection blob is
 * compared against both journal snapshots by user-visible semantics (flags'
 * PROXY_TYPE bits, ProxyServer, ProxyBypass, AutoConfigURL) — WinINet-owned
 * counter bytes never enter the comparison. current==target means Sash wrote
 * it → restore the original bytes; current==original means already restored
 * → skip; anything else was modified outside Sash → skip, report, keep the
 * journal. After writing, a fresh capture re-verifies semantics — a refresh
 * that rewrote configuration keeps the journal rather than clearing it.
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
      (typeof WIN_RESTORE_KEYS)[number][2],
      number | string | null,
    ]
  > = [];
  for (const [regName, type, key] of WIN_RESTORE_KEYS) {
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
      // A LAN blob WinINet has not (re)generated yet — restoring the
      // recorded original is the correct prior state, write it back.
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
        // The value was absent at capture time — re-read it immediately
        // before writing so a blob that materialized since is never
        // overwritten with the recorded original.
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
    // The notification itself may rewrite the connection blobs and flat
    // keys — re-verify against the restored values, polling while WinINet
    // is still settling. Anything that no longer matches the original once
    // the writes have landed keeps the journal as evidence.
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

/** The per-connection blobs WinINet rewrites for the machine LAN settings. */

/**
 * The semantic target a LAN connection blob must reach after `apply`: PROXY
 * set, AUTO_PROXY_URL cleared, ProxyServer/ProxyBypass verbatim from the
 * flat values. A parseable original contributes its DIRECT/AUTO_DETECT bits;
 * a missing or unparseable original falls back to a standard construction
 * (AUTO_DETECT from the flat setting, DIRECT left to WinINet — a fresh blob
 * may add it). The header is always a standard one: version/counter bytes
 * are WinINet-owned and never enter comparisons. This is a semantic
 * expectation for verification and journal records — never bytes to write.
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
 * A readback blob (or InternetQueryOption result) proves the applied LAN
 * settings when PROXY is on, AUTO_PROXY_URL is off, the three strings equal
 * the flat intent, and AUTO_DETECT is on when the expectation asserts it.
 * DIRECT is environment-owned and never checked. When the original blob was
 * missing or unreadable the expected carries no AUTO_DETECT claim — that bit
 * is WinINet-owned, so an expected-off never fails the readback.
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
 * Read the effective per-connection options of the default (LAN) connection
 * via InternetQueryOption(INTERNET_OPTION_PER_CONNECTION_OPTION) — the
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
 * Prove every expected LAN connection blob after the WinINet refresh. For
 * each LAN name a strict semantic match on the readback passes; a parseable
 * readback that only differs in environment-owned bits still passes the
 * loose check and its verified semantics are recorded as the target. A
 * missing or unparseable DefaultConnectionSettings falls back to
 * InternetQueryOption on the effective settings; anything unproven fails
 * the apply — the caller then rolls back through the journal.
 */
async function verifyWindowsLanConnections(
  target: WindowsSystemProxySnapshot,
  run: CommandRunner,
): Promise<void> {
  // WinINet regenerates the LAN blobs asynchronously after the refresh
  // notification — poll until the connection map stops changing so the
  // verification below and the post-apply equivalence check see the same
  // settled state (a blob materializing between the two captures would
  // otherwise read as an external modification).
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
      // The loose check passed: record the proven effective semantics (the
      // registry blob stays WinINet's own serialization, never adopted).
      target.connections[name] = serializeConnectionSemantics(sem);
      continue;
    }
    unresolved.push(name);
  }
  for (const name of unresolved) {
    if (name !== LAN_CONNECTION_DEFAULT) {
      // A legacy LAN blob that never materialized cannot be proven by the
      // per-connection API — record the absence so equivalence sees it.
      // A present-but-unverifiable blob still fails the apply.
      if (current.connections[name] === undefined) {
        delete target.connections[name];
        continue;
      }
      throw new Error(`System proxy apply could not verify the "${name}" connection settings`);
    }
    const curHex = current.connections[name];
    if (curHex !== undefined && parseConnectionBlobSemantics(curHex) !== null) {
      // A parseable blob that matched neither the strict nor the loose
      // check is a semantic conflict — the effective-settings API may
      // only stand in for a blob that is missing or unparseable, never
      // override a registry value that provably differs from the intent.
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
    // An apply is not proven until the default LAN blob exists and matches —
    // expect one even when the original had none (apply drops the
    // expectation again if only InternetQueryOption can prove the settings).
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
    // Semantic per-connection intent: prepared/crash recovery and the
    // post-apply verification compare these blobs by flags+strings, so a
    // foreign change can never be absorbed as Sash-owned.
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
