import { isPlainObject } from "../json-shape.js";
import { parseProxyEnable, parseProxyString } from "./common.js";
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
 * INTERNET_PER_CONN_OPTION_LIST serialization: u32 version, u32 write
 * counter, u32 flags, then three length-prefixed strings — u32 byte length
 * followed by ASCII bytes — for ProxyServer, ProxyBypass, AutoConfigURL.
 * Version/counter are maintained by WinINet itself and excluded — comparing
 * raw bytes false-positives on the counter bump every refresh performs.
 * Unreadable blobs return null (unknown): callers must NOT treat them as
 * empty configuration.
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

/** Registry value name of the machine-wide LAN connection blob. */
export const LAN_CONNECTION_DEFAULT = "DefaultConnectionSettings";

/** Connection entries Sash owns: the LAN blobs, never named RAS/VPN entries. */
export const WIN_LAN_CONNECTIONS = new Set([LAN_CONNECTION_DEFAULT, "SavedLegacySettings"]);

/**
 * Serialize blob semantics into the INTERNET_PER_CONN_OPTION_LIST layout
 * with a standard header (version + zero counter — WinINet owns both). The
 * result is a comparison/record value, never bytes to write to the
 * registry: a real WinINet blob carries tail bytes we cannot reproduce.
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
 * Per-connection maps match by name and user-visible semantics. An entry
 * present on only one side, or semantically different, fails the comparison
 * — a readback must never be adopted where it picked up foreign changes.
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

/** Partial writes may be restored only when every field still matches either owned value. */
export function snapshotsCompatible(
  current: SystemProxySnapshot,
  original: SystemProxySnapshot,
  target: SystemProxySnapshot,
): boolean {
  if (
    current.platform !== "win32" ||
    original.platform !== "win32" ||
    target.platform !== "win32"
  ) {
    return false;
  }
  if (
    !MANAGED_KEYS.every((key) => current[key] === original[key] || current[key] === target[key])
  ) {
    return false;
  }
  const origConns = original.connections ?? {};
  const targetConns = target.connections ?? {};
  const names = new Set([...Object.keys(current.connections ?? {}), ...Object.keys(origConns)]);
  for (const name of names) {
    const cur = current.connections?.[name];
    const orig = origConns[name];
    const tgt = targetConns[name];
    if (cur === undefined) {
      // A recorded LAN blob absent now is restorable (the backend writes the
      // original bytes); a missing named entry is reported instead.
      if (!WIN_LAN_CONNECTIONS.has(name)) return false;
      continue;
    }
    if (orig === undefined) {
      // An entry Sash's target explains is restorable; anything else is
      // foreign and blocks restoration.
      if (tgt === undefined || !blobsSemanticallyEqual(cur, tgt)) return false;
      continue;
    }
    if (
      !blobsSemanticallyEqual(cur, orig) &&
      (tgt === undefined || !blobsSemanticallyEqual(cur, tgt))
    ) {
      return false;
    }
  }
  return true;
}
