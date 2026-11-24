import { formatHostPort, normalizeEnableOptions, parseProxyString } from "./common.js";
import type {
  EnableOptions,
  SystemProxyBackend,
  SystemProxyRestoreResult,
  SystemProxyRestoreSkip,
  SystemProxySnapshot,
  SystemProxySnapshotCodec,
  SystemProxyState,
  WindowsRegistryProxyValues,
  WindowsSystemProxySnapshot,
} from "./types.js";
import { DEFAULT_BYPASS_LIST, SYSTEM_PROXY_SNAPSHOT_VERSION } from "./types.js";
import {
  blobsSemanticallyEqual,
  buildExpectedLanBlob,
  type CommandRunner,
  LAN_CONNECTION_DEFAULT,
  lanEffectiveMatch,
  parseConnectionBlobSemantics,
  parseSystemProxySnapshot,
  parseWindowsConnectionLine,
  runReg,
  runWindowsPowerShell,
  snapshotsEquivalent,
  verifyWindowsLanConnections,
  WIN_LAN_CONNECTIONS,
} from "./windows-snapshot.js";

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
    const entry = parseWindowsConnectionLine(line);
    if (entry?.type === "REG_BINARY" && /^[0-9a-fA-F]+$/.test(entry.data)) {
      connections[entry.name] = entry.data.toUpperCase();
    }
  }
  return connections;
}

export async function captureWindowsSnapshot(
  run: CommandRunner = runReg,
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
  const notified = await runWindowsPowerShell(run, script, () => true);
  if (notified) return;
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
  run: CommandRunner = runReg,
): Promise<void> {
  try {
    for (const [name, type, key] of WIN_PROXY_KEYS) {
      await applyWindowsValue(name, type, snapshot[key], run);
    }
  } finally {
    await refreshWindowsWinINet(run);
  }
  await verifyWindowsLanConnections(snapshot, run, () => captureWindowsSnapshot(run));
}

/**
 * Only revert Sash's own changes. Ignore WinINet's connection-blob counters
 * when comparing snapshots, but write the original bytes when restoring.
 */
export async function restoreWindowsSnapshot(
  original: WindowsSystemProxySnapshot,
  target: WindowsSystemProxySnapshot,
  run: CommandRunner = runReg,
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

export const windowsSystemProxySnapshotCodec: SystemProxySnapshotCodec = {
  parse: parseSystemProxySnapshot,
  equivalent: snapshotsEquivalent,
  target: createWindowsTarget,
  state: (snapshot) => windowsState(asWindowsSnapshot(snapshot)),
};

export function windowsSystemProxyBackend(): SystemProxyBackend {
  return {
    supported: true,
    snapshot: windowsSystemProxySnapshotCodec,
    capture: captureWindowsSnapshot,
    apply: (snapshot) => applyWindowsSnapshot(asWindowsSnapshot(snapshot)),
    restore: (original, target) =>
      restoreWindowsSnapshot(asWindowsSnapshot(original), asWindowsSnapshot(target)),
  };
}
