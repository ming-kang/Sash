import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hasExactOwnKeys, isPlainObject } from "../json-shape.js";
import { buildSanitizedEnv, findExecutableOnPath } from "../process.js";
import { normalizeEnableOptions, runCmd } from "./common.js";
import type {
  EnableOptions,
  PosixSystemProxySnapshot,
  SnapshotValue,
  SystemProxyBackend,
  SystemProxyRestoreSkip,
  SystemProxySnapshot,
  SystemProxySnapshotCodec,
  SystemProxyState,
} from "./types.js";

type Desktop = "gnome" | "kde";

type Runner = (cmd: string, args: string[], timeoutMs?: number) => Promise<string>;

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
 * Exact-restore metadata under reserved `$` keys inside values (ignored by
 * managed-key comparisons): `$raw` is each key's verbatim captured text,
 * restored byte-for-byte; `$absent` marks keys missing at capture (KDE),
 * restored by deletion rather than an empty write.
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
  // Conservative model: dconf cannot reliably report the user layer alone
  // (`dconf dump`/`read` merge system sources), so presence is not recorded.
  // Apply writes only changed keys; restore writes the captured raw back
  // for exactly those — an unverifiable restore fails loudly, never guesses.
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

/**
 * Read kioslaverc directly to tell an absent key (restored by deletion)
 * from present-empty (restored as empty) and present-default —
 * kreadconfig prints the same empty text for all three.
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
    const kdeKey = key.slice(KDE_GROUP.length + 1);
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
    values[key] = text === "" ? "" : kdeKey === "ProxyType" ? Number(text) : text;
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
    const kdeKey = key.slice(KDE_GROUP.length + 1);
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
    if (current === text) continue;
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

const DESKTOP_MANAGED_KEYS = { gnome: GNOME_MANAGED_KEYS, kde: KDE_MANAGED_KEYS } as const;

/**
 * Which desktop's key space a snapshot belongs to, by content — never by the
 * current environment, so journals stay readable across environments. An
 * empty snapshot matches neither and falls back to the managed-key union.
 */
function linuxSnapshotDesktop(values: SnapshotValues): Desktop | null {
  if ("mode" in values) return "gnome";
  if ("Proxy Settings/ProxyType" in values) return "kde";
  return null;
}

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
  // GNOME snapshots carry no presence metadata while KDE ones always emit
  // an ABSENT_KEYS map — normalize absent or non-object values to an empty
  // set so the two compare equal.
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

/** One managed key matches a snapshot by value AND (KDE) presence. */
function linuxSnapshotKeyEqual(
  left: PosixSystemProxySnapshot,
  right: PosixSystemProxySnapshot,
  key: string,
): boolean {
  return (
    snapshotValueEqual(left.values[key], right.values[key]) &&
    absentSet(left.values).has(key) === absentSet(right.values).has(key)
  );
}

const KDE_MANAGED_KEY_SET = new Set<string>(KDE_MANAGED_KEYS);

/** Setting location shown in skip reports: KDE's group/key, gsettings' schema + leaf. */
function linuxKeyService(key: string): string {
  if (KDE_MANAGED_KEY_SET.has(key)) return key;
  const dot = key.indexOf(".");
  return dot > 0
    ? `org.gnome.system.proxy.${key.slice(0, dot)} ${key.slice(dot + 1)}`
    : `${GNOME_SCHEMAS.proxy} ${key}`;
}

interface LinuxRestorePlan {
  /** Original values for just the keys to write, with restore metadata. */
  writes: SnapshotValues;
  keys: string[];
  skipped: SystemProxyRestoreSkip[];
}

/**
 * Per managed key, the current state (value AND presence) must equal the
 * recorded original or the Sash target — anything else is an outside change
 * reported as skipped and never written. Keys still at target get their
 * original queued, so a crash mid-restore leaves every key at original or
 * target and the journal stays recoverable.
 */
function planLinuxRestore(
  original: PosixSystemProxySnapshot,
  target: PosixSystemProxySnapshot,
  current: PosixSystemProxySnapshot,
): LinuxRestorePlan {
  const desktop = linuxSnapshotDesktop(original.values);
  const keys = desktop === null ? MANAGED_KEYS : DESKTOP_MANAGED_KEYS[desktop];
  const absent = original.values[ABSENT_KEYS];
  const writes: SnapshotValues = {
    [RAW_VALUES]: rawMap(original.values),
    [ABSENT_KEYS]: isPlainObject(absent) ? { ...absent } : {},
  };
  const plan: LinuxRestorePlan = { writes, keys: [], skipped: [] };
  for (const key of keys) {
    if (linuxSnapshotKeyEqual(current, original, key)) continue;
    if (linuxSnapshotKeyEqual(current, target, key)) {
      plan.keys.push(key);
      const value = original.values[key];
      // A key the original never recorded has nothing to write — it stays
      // in plan.keys so verification reports it and the journal survives.
      if (value !== undefined) writes[key] = value;
      continue;
    }
    plan.skipped.push({ key, service: linuxKeyService(key), reason: "modified" });
  }
  return plan;
}

/**
 * Journal-scoped restore built on the desktop's own capture/apply: writes
 * the recorded originals for keys still holding Sash's target, then proves
 * each written key by a fresh capture — what no longer matches is reported
 * skipped so the journal stays as evidence.
 */
function linuxRestorer(
  captureValues: () => Promise<SnapshotValues>,
  applyValues: (values: SnapshotValues) => Promise<void>,
): SystemProxyBackend["restore"] {
  return async (original, target) => {
    if (original.platform !== "linux" || target.platform !== "linux") {
      throw new Error("Expected Linux system proxy snapshots");
    }
    const o = original as PosixSystemProxySnapshot;
    const t = target as PosixSystemProxySnapshot;
    const plan = planLinuxRestore(o, t, linuxSnapshot(await captureValues()));
    if (plan.keys.length === 0) return { skipped: plan.skipped };
    await applyValues(plan.writes);
    const restored = linuxSnapshot(await captureValues());
    for (const key of plan.keys) {
      if (!linuxSnapshotKeyEqual(restored, o, key)) {
        plan.skipped.push({ key, service: linuxKeyService(key), reason: "modified" });
      }
    }
    return { skipped: plan.skipped };
  };
}

function enabledState(values: SnapshotValues): {
  enabled: boolean;
  server?: string;
  pac?: boolean;
} {
  const desktop = linuxSnapshotDesktop(values);
  if (desktop === "gnome") {
    const mode = values.mode;
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
  if (desktop === "kde") {
    // KDE proxyType: 1 manual, 3 auto PAC, 4 env.
    const proxyType = values["Proxy Settings/ProxyType"];
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
    target(options: EnableOptions, original: SystemProxySnapshot): SystemProxySnapshot {
      const normalized = normalizeEnableOptions(options);
      const previous = (original as PosixSystemProxySnapshot).values ?? {};
      const host = normalized.host;
      const port = normalized.port;
      const bypass = normalized.bypass;
      const target: SnapshotValues = {
        ...previous,
        [RAW_VALUES]: { ...rawMap(previous) },
        [ABSENT_KEYS]: { ...(isPlainObject(previous[ABSENT_KEYS]) ? previous[ABSENT_KEYS] : {}) },
      };
      const set = (entries: Record<string, SnapshotValue>) => {
        for (const [key, value] of Object.entries(entries)) {
          target[key] = value;
          // A changed value drops the captured raw text — it is written
          // serialized, never an unrelated byte string — and is by
          // definition no longer absent.
          if (!snapshotValueEqual(previous[key], value)) {
            delete (target[RAW_VALUES] as Record<string, string>)[key];
            delete (target[ABSENT_KEYS] as Record<string, boolean>)[key];
          }
        }
      };
      if (linuxSnapshotDesktop(previous) !== "kde") {
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
  const runner = deps.run ?? runCmd;
  const snapshot = linuxSystemProxySnapshotCodec();
  const unsupported: SystemProxyBackend = {
    supported: false,
    snapshot,
    capture() {
      return Promise.reject(new Error("System proxy is not supported on this desktop"));
    },
    apply() {
      return Promise.reject(new Error("System proxy is not supported on this desktop"));
    },
    restore() {
      return Promise.reject(new Error("System proxy is not supported on this desktop"));
    },
  };

  const desktop = detectLinuxDesktop(env);
  if (desktop === "gnome") {
    if (!findExecutableOnPath("gsettings", env)) return unsupported;
    return {
      supported: true,
      snapshot,
      capture: () => captureGnome(runner).then(linuxSnapshot),
      apply: (value) => applyGnome(runner, (value as PosixSystemProxySnapshot).values),
      restore: linuxRestorer(
        () => captureGnome(runner),
        (values) => applyGnome(runner, values),
      ),
    };
  }
  if (desktop === "kde") {
    const tools = kdeProxyTypeName(env);
    if (!tools) return unsupported;
    return {
      supported: true,
      snapshot,
      capture: () => captureKde(runner, tools, env).then(linuxSnapshot),
      apply: (value) => applyKde(runner, tools, (value as PosixSystemProxySnapshot).values, env),
      restore: linuxRestorer(
        () => captureKde(runner, tools, env),
        (values) => applyKde(runner, tools, values, env),
      ),
    };
  }
  return unsupported;
}
