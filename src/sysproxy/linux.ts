import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hasExactOwnKeys, isPlainObject } from "../json-shape.js";
import { buildSanitizedEnv, findExecutableOnPath, runSanitizedCommandAsync } from "../process.js";
import type {
  EnableOptions,
  PosixSystemProxySnapshot,
  SnapshotValue,
  SystemProxyBackend,
  SystemProxySnapshot,
  SystemProxySnapshotCodec,
  SystemProxyState,
} from "./types.js";

type Desktop = "gnome" | "kde";

type Runner = (cmd: string, args: string[], timeoutMs?: number) => Promise<string>;

const run: Runner = (cmd, args, timeoutMs = 5000) =>
  runSanitizedCommandAsync(cmd, args, { timeoutMs });

/**
 * The GNOME desktop names that honour org.gnome.system.proxy, and the KDE ones
 * honouring the KConfig "Proxy Settings" group. Anything else (including a
 * headless session with no desktop) reports supported:false.
 */
const GNOME_DESKTOPS = new Set([
  "gnome",
  "ubuntu:gnome",
  "ubuntu",
  "x-cinnamon",
  "cinnamon",
  "budgie",
  "budgie-desktop",
  "pantheon",
  "ukui",
  "unity",
  "mate",
  "zorin",
  "zorin:gnome",
]);
const KDE_DESKTOPS = new Set(["kde", "plasma", "trinity"]);

export function detectLinuxDesktop(env: NodeJS.ProcessEnv = process.env): Desktop | null {
  const raw = [
    env.XDG_CURRENT_DESKTOP,
    env.DESKTOP_SESSION,
    env.GNOME_DESKTOP_SESSION_ID ? "gnome" : undefined,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(";")
    .toLowerCase();
  if (!raw) return null;
  for (const name of raw.split(/[;:]/)) {
    const token = name.trim();
    if (KDE_DESKTOPS.has(token)) return "kde";
  }
  for (const name of raw.split(/[;:]/)) {
    const token = name.trim();
    if (GNOME_DESKTOPS.has(token) || token.endsWith(":gnome")) return "gnome";
  }
  return null;
}

const GNOME_SCHEMAS = {
  proxy: "org.gnome.system.proxy",
  http: "org.gnome.system.proxy.http",
  https: "org.gnome.system.proxy.https",
  socks: "org.gnome.system.proxy.socks",
  ftp: "org.gnome.system.proxy.ftp",
} as const;

const GNOME_MANAGED_KEYS = [
  "mode",
  "autoconfig-url",
  "http.enabled",
  "http.host",
  "http.port",
  "http.use-authentication",
  "http.authentication-user",
  "http.authentication-password",
  "https.host",
  "https.port",
  "socks.host",
  "socks.port",
  "ftp.host",
  "ftp.port",
  "ignore-hosts",
] as const;

const KDE_MANAGED_KEYS = [
  "Proxy Settings/ProxyType",
  "Proxy Settings/Proxy Config Script",
  "Proxy Settings/httpProxy",
  "Proxy Settings/httpsProxy",
  "Proxy Settings/socksProxy",
  "Proxy Settings/ftpProxy",
  "Proxy Settings/NoProxy",
] as const;

type SnapshotValues = PosixSystemProxySnapshot["values"];

/**
 * Exact-restore metadata carried inside the snapshot's values under
 * reserved `$` keys (ignored by every managed-key comparison):
 * `$raw` holds each key's verbatim raw text as captured — restoring it
 * byte-for-byte instead of re-serializing a parsed value; `$absent`
 * marks keys that did not exist at capture time (KDE), restored by
 * deleting the key rather than writing an empty one.
 */
const RAW_VALUES = "$raw";
const ABSENT_KEYS = "$absent";

function rawMap(values: SnapshotValues): Record<string, string> {
  const raw = values[RAW_VALUES];
  return isPlainObject(raw) ? (raw as Record<string, string>) : {};
}

function absentSet(values: SnapshotValues): Set<string> {
  const absent = values[ABSENT_KEYS];
  return isPlainObject(absent) ? new Set(Object.keys(absent)) : new Set();
}

function isSnapshotValue(value: unknown): value is SnapshotValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) return value.every(isSnapshotValue);
  if (isPlainObject(value)) return Object.values(value).every(isSnapshotValue);
  return false;
}

function linuxSnapshot(values: SnapshotValues): PosixSystemProxySnapshot {
  return { version: 1, platform: "linux", values };
}

async function captureGnome(runner: Runner): Promise<SnapshotValues> {
  // Conservative model: the dconf CLI cannot reliably report the user
  // layer alone (`dconf dump`/`read` merge system sources), so presence
  // is not recorded. Apply writes only keys that actually change and
  // restore writes the captured raw back for exactly those keys — a
  // restore that cannot be verified fails loudly instead of guessing.
  const values: SnapshotValues = { [RAW_VALUES]: {} };
  for (const key of GNOME_MANAGED_KEYS) {
    const dot = key.indexOf(".");
    const [schemaName, leaf] =
      dot > 0
        ? [`org.gnome.system.proxy.${key.slice(0, dot)}`, key.slice(dot + 1)]
        : [GNOME_SCHEMAS.proxy, key];
    let raw: string;
    try {
      raw = await runner("gsettings", ["get", schemaName, leaf]);
    } catch (error) {
      // A failed read must abort the snapshot — recording null would
      // silently drop the user's current value on restore.
      throw new Error(`Could not read GNOME proxy setting ${key}: ${(error as Error).message}`);
    }
    const trimmed = raw.trim();
    values[key] = parseGVariant(trimmed);
    (values[RAW_VALUES] as Record<string, string>)[key] = trimmed;
  }
  return values;
}

function parseGVariant(text: string): string | number | boolean | string[] | null {
  // GLib prints typed-empty containers with an `@as <type>` prefix, e.g.
  // `@as []` for an empty string array — strip the annotation.
  if (text.startsWith("@as ")) return parseGVariant(text.slice(4));
  if (text === "false" || text === "true") return text === "true";
  if (/^-?\d+$/.test(text)) return Number(text);
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    const items: string[] = [];
    const re = /'((?:[^'\\]|\\.)*)'/g;
    for (let match = re.exec(inner); match !== null; match = re.exec(inner)) {
      items.push(match[1] ?? "");
    }
    return items;
  }
  const stringMatch = /^'((?:[^'\\]|\\.)*)'$/.exec(text);
  if (stringMatch) return (stringMatch[1] ?? "").replace(/''/g, "'").replace(/\\'/g, "'");
  return text || null;
}

function gvariant(value: string | number | boolean | string[] | null): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value))
    return `[${value.map((item) => `'${item.replace(/'/g, "''")}'`).join(", ")}]`;
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

async function applyGnome(runner: Runner, values: SnapshotValues): Promise<void> {
  const raw = rawMap(values);
  for (const key of GNOME_MANAGED_KEYS) {
    const value = values[key];
    if (value === undefined) continue;
    const dot = key.indexOf(".");
    const [schemaName, leaf] =
      dot > 0
        ? [`org.gnome.system.proxy.${key.slice(0, dot)}`, key.slice(dot + 1)]
        : [GNOME_SCHEMAS.proxy, key];
    // Write the captured raw text verbatim when we have it, else the
    // serialized target value — and only when the text actually changes,
    // so credentials and unrelated keys are never touched.
    const desired = raw[key] ?? gvariant(value as string | number | boolean | string[] | null);
    let current: string;
    try {
      current = (await runner("gsettings", ["get", schemaName, leaf])).trim();
    } catch {
      current = "";
    }
    if (current === desired) continue;
    await runner("gsettings", ["set", schemaName, leaf, desired]);
  }
}

function kdeProxyTypeName(env: NodeJS.ProcessEnv): { read: string; write: string } | null {
  const write =
    findExecutableOnPath("kwriteconfig6", env) ?? findExecutableOnPath("kwriteconfig5", env);
  const read =
    findExecutableOnPath("kreadconfig6", env) ?? findExecutableOnPath("kreadconfig5", env);
  return write && read ? { read, write } : null;
}

const KDE_GROUP = "Proxy Settings";
const KDE_FIELD = {
  ProxyType: "ProxyType",
  "Proxy Config Script": "Proxy Config Script",
  httpProxy: "httpProxy",
  httpsProxy: "httpsProxy",
  socksProxy: "socksProxy",
  ftpProxy: "ftpProxy",
  NoProxy: "NoProxy",
} as const;

/**
 * Read kioslaverc directly to distinguish an absent key (restored by
 * deletion) from a present-but-empty one (restored as an empty value)
 * and a present one holding the schema default — kreadconfig prints the
 * same empty text for all three.
 */
async function kdePresentKeys(env: NodeJS.ProcessEnv): Promise<Set<string>> {
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  let text = "";
  try {
    text = await fsp.readFile(path.join(configHome, "kioslaverc"), "utf8");
  } catch (error) {
    // Only a missing file means no user keys; a permission or IO error
    // is never reported as "everything absent".
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  const present = new Set<string>();
  let inGroup = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inGroup = trimmed === `[${KDE_GROUP}]`;
      continue;
    }
    if (inGroup) {
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        // KDE key options and locale suffixes (`key[$i]`, `key[fr]`)
        // still mean the base key carries a user value.
        const name = trimmed.slice(0, eq).replace(/\[.*\]$/, "");
        present.add(name);
      }
    }
  }
  return present;
}

async function captureKde(
  runner: Runner,
  tools: { read: string; write: string },
  env: NodeJS.ProcessEnv,
): Promise<SnapshotValues> {
  const values: SnapshotValues = { [RAW_VALUES]: {}, [ABSENT_KEYS]: {} };
  const present = await kdePresentKeys(env);
  for (const key of KDE_MANAGED_KEYS) {
    const field = key.slice(KDE_GROUP.length + 1) as keyof typeof KDE_FIELD;
    const kdeKey = KDE_FIELD[field];
    if (!present.has(kdeKey)) {
      values[key] = null;
      (values[ABSENT_KEYS] as Record<string, boolean>)[key] = true;
      continue;
    }
    let raw: string;
    try {
      raw = await runner(tools.read, [
        "--file",
        "kioslaverc",
        "--group",
        KDE_GROUP,
        "--key",
        kdeKey,
      ]);
    } catch (error) {
      throw new Error(`Could not read KDE proxy setting ${key}: ${(error as Error).message}`);
    }
    // kreadconfig prints the entry text plus one terminator newline —
    // keep every other byte verbatim so spaced values round-trip.
    const text = raw.replace(/\r?\n$/, "");
    values[key] = text === "" ? "" : field === "ProxyType" ? Number(text) : text;
    (values[RAW_VALUES] as Record<string, string>)[key] = text;
  }
  return values;
}

async function applyKde(
  runner: Runner,
  tools: { read: string; write: string },
  values: SnapshotValues,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const raw = rawMap(values);
  const absent = absentSet(values);
  const present = await kdePresentKeys(env);
  for (const key of KDE_MANAGED_KEYS) {
    const value = values[key];
    if (value === undefined) continue;
    const field = key.slice(KDE_GROUP.length + 1) as keyof typeof KDE_FIELD;
    const kdeKey = KDE_FIELD[field];
    if (absent.has(key)) {
      // Absent at capture: delete the key so it falls back to the
      // schema/merged default instead of leaving a user-level override.
      if (present.has(kdeKey)) {
        await runner(tools.write, [
          "--file",
          "kioslaverc",
          "--group",
          KDE_GROUP,
          "--key",
          kdeKey,
          "--delete",
        ]);
      }
      continue;
    }
    const text = raw[key] ?? (value === null ? "" : String(value));
    let current: string | null = null;
    if (present.has(kdeKey)) {
      try {
        current = (
          await runner(tools.read, ["--file", "kioslaverc", "--group", KDE_GROUP, "--key", kdeKey])
        ).trim();
      } catch {
        current = null;
      }
    }
    if (current === text) continue; // only write keys that actually change
    await runner(tools.write, [
      "--file",
      "kioslaverc",
      "--group",
      KDE_GROUP,
      "--key",
      kdeKey,
      text,
    ]);
  }
  // KIO daemons cache the proxy config; notify whichever kded matches
  // the running Plasma generation.
  for (const daemon of ["kded6", "kded5"]) {
    try {
      await runner("dbus-send", [
        "--session",
        `--dest=org.kde.${daemon}`,
        "/modules/networkproxy",
        `org.kde.${daemon}.signalReloadConfig`,
      ]);
      return;
    } catch {}
  }
  console.warn("[sash] could not notify kded of proxy changes; caches may be stale");
}

const MANAGED_KEYS = [...GNOME_MANAGED_KEYS, ...KDE_MANAGED_KEYS];

function parsePosix(value: unknown): PosixSystemProxySnapshot {
  if (
    !isPlainObject(value) ||
    !hasExactOwnKeys(value, ["version", "platform", "values"]) ||
    value.version !== 1 ||
    value.platform !== "linux" ||
    !isPlainObject(value.values)
  ) {
    throw new Error("Invalid system proxy snapshot: expected a version 1 Linux snapshot");
  }
  const values: SnapshotValues = {};
  for (const [k, v] of Object.entries(value.values)) {
    if (isSnapshotValue(v)) values[k] = v;
  }
  return { version: 1, platform: "linux", values };
}

function snapshotValueEqual(a: SnapshotValue | undefined, b: SnapshotValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => item === b[i])
    );
  }
  return a === b || (a === undefined && b === null) || (a === null && b === undefined);
}

function sameAbsence(left: SnapshotValues, right: SnapshotValues): boolean {
  // GNOME snapshots carry no presence metadata at all while KDE ones
  // always emit a (possibly empty) ABSENT_KEYS map — normalize absent
  // or non-object values to an empty set so the two compare equal.
  const a = isPlainObject(left[ABSENT_KEYS]) ? left[ABSENT_KEYS] : {};
  const b = isPlainObject(right[ABSENT_KEYS]) ? right[ABSENT_KEYS] : {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (
      Boolean((a as Record<string, unknown>)[key]) !== Boolean((b as Record<string, unknown>)[key])
    )
      return false;
  }
  return true;
}

function valuesMatch(left: PosixSystemProxySnapshot, right: PosixSystemProxySnapshot): boolean {
  return (
    sameAbsence(left.values, right.values) &&
    MANAGED_KEYS.every((key) => snapshotValueEqual(left.values[key], right.values[key]))
  );
}

function enabledState(values: SnapshotValues): {
  enabled: boolean;
  server?: string;
  pac?: boolean;
} {
  // GNOME manual mode.
  const mode = values.mode;
  if (typeof mode === "string") {
    if (mode === "manual") {
      const host = values["http.host"];
      const port = values["http.port"];
      const socksHost = values["socks.host"];
      const socksPort = values["socks.port"];
      const server =
        typeof host === "string" && host && typeof port === "number"
          ? `${host}:${port}`
          : typeof socksHost === "string" && socksHost && typeof socksPort === "number"
            ? `${socksHost}:${socksPort}`
            : undefined;
      return { enabled: true, server };
    }
    if (mode === "auto") return { enabled: true, pac: true };
    return { enabled: false };
  }
  // KDE proxyType: 1 manual, 3 auto PAC, 4 env.
  const proxyType = values["Proxy Settings/ProxyType"];
  if (typeof proxyType === "number") {
    if (proxyType === 1) {
      const http = values["Proxy Settings/httpProxy"];
      const https = values["Proxy Settings/httpsProxy"];
      const socks = values["Proxy Settings/socksProxy"];
      const server =
        typeof http === "string" && http
          ? http
          : typeof https === "string" && https
            ? https
            : typeof socks === "string" && socks
              ? socks
              : undefined;
      return { enabled: true, server };
    }
    if (proxyType === 3) return { enabled: true, pac: true };
    return { enabled: false };
  }
  return { enabled: false };
}

export function linuxSystemProxySnapshotCodec(): SystemProxySnapshotCodec {
  return {
    parse: parsePosix,
    equivalent(left, right) {
      return (
        left.platform === "linux" &&
        right.platform === "linux" &&
        valuesMatch(left as PosixSystemProxySnapshot, right as PosixSystemProxySnapshot)
      );
    },
    compatible(current, original, target) {
      if (
        current.platform !== "linux" ||
        original.platform !== "linux" ||
        target.platform !== "linux"
      ) {
        return false;
      }
      const c = (current as PosixSystemProxySnapshot).values;
      const o = (original as PosixSystemProxySnapshot).values;
      const t = (target as PosixSystemProxySnapshot).values;
      const cAbsent = absentSet(c);
      const oAbsent = absentSet(o);
      const tAbsent = absentSet(t);
      // Per key, the current state (value AND presence) must equal the
      // captured original or the Sash target — a key Sash changed is
      // expected to match the target; an externally modified key
      // matches neither and blocks the restore.
      return MANAGED_KEYS.every(
        (key) =>
          (snapshotValueEqual(c[key], o[key]) && cAbsent.has(key) === oAbsent.has(key)) ||
          (snapshotValueEqual(c[key], t[key]) && cAbsent.has(key) === tAbsent.has(key)),
      );
    },
    target(options: EnableOptions, original: SystemProxySnapshot): SystemProxySnapshot {
      const previous = (original as PosixSystemProxySnapshot).values ?? {};
      const host = options.host ?? "127.0.0.1";
      const port = options.port;
      const bypass = options.bypass ?? [];
      const target: SnapshotValues = {
        ...previous,
        [RAW_VALUES]: { ...rawMap(previous) },
        [ABSENT_KEYS]: { ...(isPlainObject(previous[ABSENT_KEYS]) ? previous[ABSENT_KEYS] : {}) },
      };
      const set = (entries: Record<string, SnapshotValue>) => {
        for (const [key, value] of Object.entries(entries)) {
          target[key] = value;
          // A changed value drops the captured raw text so it is written
          // serialized, never an unrelated byte string; and it is by
          // definition no longer absent.
          if (!snapshotValueEqual(previous[key], value)) {
            delete (target[RAW_VALUES] as Record<string, string>)[key];
            delete (target[ABSENT_KEYS] as Record<string, boolean>)[key];
          }
        }
      };
      if ("mode" in previous || !("Proxy Settings/ProxyType" in previous)) {
        set({
          mode: "manual",
          "http.enabled": true,
          "http.host": host,
          "http.port": port,
          "https.host": host,
          "https.port": port,
          "socks.host": host,
          "socks.port": port,
          "ftp.host": host,
          "ftp.port": port,
          "ignore-hosts": bypass,
        });
        return linuxSnapshot(target);
      }
      set({
        "Proxy Settings/ProxyType": 1,
        "Proxy Settings/httpProxy": `http://${host} ${port}`,
        "Proxy Settings/httpsProxy": `http://${host} ${port}`,
        "Proxy Settings/socksProxy": `socks://${host} ${port}`,
        "Proxy Settings/ftpProxy": `http://${host} ${port}`,
        "Proxy Settings/NoProxy": bypass.join(","),
      });
      return linuxSnapshot(target);
    },
    state(snapshot: SystemProxySnapshot): SystemProxyState {
      if (snapshot.platform !== "linux") return { supported: true, enabled: false };
      const info = enabledState((snapshot as PosixSystemProxySnapshot).values);
      return {
        supported: true,
        enabled: info.enabled,
        server: info.server,
        details: info.pac ? "auto proxy (PAC)" : undefined,
      };
    },
  };
}

export interface LinuxSystemProxyDeps {
  env?: NodeJS.ProcessEnv;
  run?: Runner;
}

export function linuxSystemProxyBackend(deps: LinuxSystemProxyDeps = {}): SystemProxyBackend {
  const env = deps.env ?? buildSanitizedEnv();
  const runner = deps.run ?? run;
  const desktop = detectLinuxDesktop(env);
  const tools =
    desktop === "gnome"
      ? findExecutableOnPath("gsettings", env)
        ? ({ read: "gsettings", write: "gsettings" } as const)
        : null
      : desktop === "kde"
        ? kdeProxyTypeName(env)
        : null;

  if (!desktop || !tools) {
    return {
      supported: false,
      snapshot: linuxSystemProxySnapshotCodec(),
      capture() {
        return Promise.reject(new Error("System proxy is not supported on this desktop"));
      },
      apply() {
        return Promise.reject(new Error("System proxy is not supported on this desktop"));
      },
    };
  }

  const snapshot = linuxSystemProxySnapshotCodec();
  if (desktop === "gnome") {
    return {
      supported: true,
      snapshot,
      capture: () => captureGnome(runner).then(linuxSnapshot),
      apply: (value) => applyGnome(runner, (value as PosixSystemProxySnapshot).values),
    };
  }
  return {
    supported: true,
    snapshot,
    capture: () =>
      captureKde(runner, tools as { read: string; write: string }, env).then(linuxSnapshot),
    apply: (value) =>
      applyKde(
        runner,
        tools as { read: string; write: string },
        (value as PosixSystemProxySnapshot).values,
        env,
      ),
  };
}
