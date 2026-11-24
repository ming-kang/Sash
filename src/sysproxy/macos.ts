import { isPlainObject } from "../json-shape.js";
import { runSanitizedCommandAsync } from "../process.js";
import { formatHostPort } from "./common.js";
import {
  DEFAULT_BYPASS_LIST,
  type EnableOptions,
  type PosixSystemProxySnapshot,
  SYSTEM_PROXY_SNAPSHOT_VERSION,
  type SystemProxyBackend,
  type SystemProxyRestoreResult,
  type SystemProxyRestoreSkip,
  type SystemProxySnapshot,
  type SystemProxySnapshotCodec,
  type SystemProxyState,
} from "./types.js";

const NETWORKSETUP = "/usr/sbin/networksetup";

type ManualProxyValues = {
  enabled: boolean;
  server: string;
  port: number;
  authenticated: boolean;
};

type AutoProxyValues = {
  enabled: boolean;
  url: string;
};

type ServiceProxyValues = {
  /** Display name at capture time — metadata only; the record is keyed by
   * the service's stable UUID and renamed services resolve back at apply. */
  serviceName: string;
  webProxy: ManualProxyValues;
  secureWebProxy: ManualProxyValues;
  socksProxy: ManualProxyValues;
  autoProxyUrl: AutoProxyValues;
  autoProxyDiscovery: { enabled: boolean };
  bypass: string[];
};

/** Snapshot services keyed by the service's persistent UUID, not its name. */
type MacosServices = Record<string, ServiceProxyValues>;

async function networksetup(...args: string[]): Promise<string> {
  return runSanitizedCommandAsync(NETWORKSETUP, args, { timeoutMs: 10_000 });
}

async function allNetworkServices(): Promise<string[]> {
  const output = await networksetup("-listallnetworkservices");
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("*") && !line.startsWith("An asterisk"));
}

const PREFERENCES_PLIST = "/Library/Preferences/SystemConfiguration/preferences.plist";

/**
 * service display name <-> persistent UUID, read from SystemConfiguration
 * preferences (the same store networksetup writes). Names are user-editable
 * and collide across service switches; the UUID survives renames.
 */
async function serviceIdMap(): Promise<{
  byUuid: Map<string, string>;
  byName: Map<string, string>;
}> {
  const output = await runSanitizedCommandAsync("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    PREFERENCES_PLIST,
  ]);
  const byUuid = new Map<string, string>();
  const byName = new Map<string, string>();
  try {
    const parsed = JSON.parse(output) as { NetworkServices?: Record<string, unknown> };
    for (const [uuid, entry] of Object.entries(parsed.NetworkServices ?? {})) {
      if (!isPlainObject(entry)) continue;
      const name = entry.UserDefinedName;
      if (typeof name !== "string" || !name) continue;
      byUuid.set(uuid, name);
      if (!byName.has(name)) byName.set(name, uuid);
    }
  } catch {
    // Fall through: callers treat an empty map as "no ids resolvable".
  }
  return { byUuid, byName };
}

/**
 * Only services that actually carry traffic right now (enabled AND holding
 * an IP address) are in scope. Disabled or unplugged services keep whatever
 * proxy values they had; we never touch them, so nothing has to be compared
 * or restored there.
 */
async function serviceIsActive(service: string): Promise<boolean> {
  const info = await networksetup("-getinfo", service).catch(() => "");
  return /^IP address:\s*\d+/m.test(info);
}

async function activeNetworkServices(): Promise<string[]> {
  const names = await allNetworkServices();
  const active: string[] = [];
  for (const name of names) {
    if (await serviceIsActive(name)) active.push(name);
  }
  return active;
}

function parseManualProxy(output: string): ManualProxyValues {
  const fields = Object.fromEntries(
    output
      .split("\n")
      .map((line) => line.match(/^([^:]+):\s*(.*)$/)?.slice(1) as [string, string])
      .filter((pair): pair is [string, string] => Array.isArray(pair)),
  );
  const server = fields.Server ?? "";
  return {
    enabled: /^yes$/i.test(fields.Enabled ?? ""),
    server: server === "(null)" ? "" : server,
    port: Number.parseInt(fields.Port ?? "0", 10) || 0,
    authenticated: /^yes|1$/i.test(fields["Authenticated Proxy Enabled"] ?? ""),
  };
}

function parseAutoProxyUrl(output: string): AutoProxyValues {
  const fields = Object.fromEntries(
    output
      .split("\n")
      .map((line) => line.match(/^([^:]+):\s*(.*)$/)?.slice(1) as [string, string])
      .filter((pair): pair is [string, string] => Array.isArray(pair)),
  );
  const url = fields.URL ?? "";
  // `networksetup` prints "(null)" for an unset PAC URL; normalize to "".
  return { enabled: /^yes$/i.test(fields.Enabled ?? ""), url: url === "(null)" ? "" : url };
}

function parseAutoDiscovery(output: string): { enabled: boolean } {
  return { enabled: /Auto Proxy Discovery:\s*On/i.test(output) };
}

function parseBypass(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/there aren't any bypass domains/i.test(line));
}

/**
 * null means the service is NOT representable (an authenticated proxy whose
 * credentials we cannot losslessly capture) — it is left completely
 * untouched: no writes, and excluded from the snapshot so equivalence
 * checks never compare values we did not set.
 */
async function captureService(
  service: string,
): Promise<Omit<ServiceProxyValues, "serviceName"> | null> {
  const [webProxy, secureWebProxy, socksProxy, autoProxyUrl, autoProxyDiscovery, bypass] =
    await Promise.all([
      networksetup("-getwebproxy", service).then(parseManualProxy),
      networksetup("-getsecurewebproxy", service).then(parseManualProxy),
      networksetup("-getsocksfirewallproxy", service).then(parseManualProxy),
      networksetup("-getautoproxyurl", service).then(parseAutoProxyUrl),
      networksetup("-getproxyautodiscovery", service).then(parseAutoDiscovery),
      networksetup("-getproxybypassdomains", service).then(parseBypass),
    ]);
  if (webProxy.authenticated || secureWebProxy.authenticated || socksProxy.authenticated) {
    return null;
  }
  return { webProxy, secureWebProxy, socksProxy, autoProxyUrl, autoProxyDiscovery, bypass };
}

async function captureMacosSnapshot(): Promise<SystemProxySnapshot> {
  const services: MacosServices = {};
  const { byName } = await serviceIdMap();
  for (const service of await activeNetworkServices()) {
    const captured = await captureService(service);
    if (captured) {
      // UUID key when resolvable; the name itself is a last-resort key for
      // services absent from preferences.plist (restore still best-effort).
      const key = byName.get(service) ?? service;
      services[key] = { ...captured, serviceName: service };
    }
  }
  return { version: SYSTEM_PROXY_SNAPSHOT_VERSION, platform: "darwin", values: { services } };
}

/**
 * Write the FULL record, not just the state bit: server/port are restored
 * even when the proxy stays disabled, so the machine keeps its stored
 * values and equivalence checks see the true pre-Sash configuration.
 */
async function setManualProxy(
  service: string,
  setArgs: string,
  stateArgs: string,
  value: ManualProxyValues,
): Promise<void> {
  // Always write the values ("" clears a stored server/port) so nothing
  // Sash wrote can linger inside a proxy that ends up disabled.
  await networksetup(setArgs, service, value.server, String(value.port));
  await networksetup(stateArgs, service, value.enabled ? "on" : "off");
}

async function writeServiceProxy(service: string, values: ServiceProxyValues): Promise<void> {
  await setManualProxy(service, "-setwebproxy", "-setwebproxystate", values.webProxy);
  await setManualProxy(
    service,
    "-setsecurewebproxy",
    "-setsecurewebproxystate",
    values.secureWebProxy,
  );
  await setManualProxy(
    service,
    "-setsocksfirewallproxy",
    "-setsocksfirewallproxystate",
    values.socksProxy,
  );
  // PAC: write the URL back when one is recorded (a disabled PAC keeps
  // its stored URL on real systems), then set the state. Never rewrite a
  // stored URL when none was recorded.
  if (values.autoProxyUrl.url) {
    await networksetup("-setautoproxyurl", service, values.autoProxyUrl.url);
  }
  await networksetup("-setautoproxystate", service, values.autoProxyUrl.enabled ? "on" : "off");
  await networksetup(
    "-setproxyautodiscovery",
    service,
    values.autoProxyDiscovery.enabled ? "on" : "off",
  );
  await networksetup(
    "-setproxybypassdomains",
    service,
    ...(values.bypass.length > 0 ? values.bypass : ["Empty"]),
  );
}

async function applyMacosSnapshot(snapshot: PosixSystemProxySnapshot): Promise<void> {
  const services = readServices(snapshot.values);
  const { byUuid } = await serviceIdMap();
  const liveNames = new Set(byUuid.values());
  for (const [key, values] of Object.entries(services)) {
    // The journal's service list is authoritative — apply runs even if the
    // service is offline now. A uuid key resolves to its current name (the
    // service may have been renamed); a vanished uuid never falls back to
    // the recorded name — a same-named replacement is a different service.
    // Legacy name-keyed records resolve through the name itself.
    const service = byUuid.get(key) ?? (liveNames.has(key) ? key : undefined);
    if (!service) continue;
    await writeServiceProxy(service, values);
  }
}

/**
 * Comparable proxy state with identity metadata (serviceName) and key order
 * removed — two captures of the same state compare equal even when the
 * service was renamed.
 */
function proxyStateKey(values: Omit<ServiceProxyValues, "serviceName">): string {
  return JSON.stringify({
    webProxy: values.webProxy,
    secureWebProxy: values.secureWebProxy,
    socksProxy: values.socksProxy,
    autoProxyUrl: values.autoProxyUrl,
    autoProxyDiscovery: values.autoProxyDiscovery,
    bypass: [...values.bypass].sort(),
  });
}

/**
 * Journal-scoped restore: for every service the journal recorded (resolved
 * by UUID, offline included) write the original values back only while the
 * current values are still what Sash set (or already restored). A service
 * modified outside Sash or removed is skipped and reported — never
 * overwritten. The display name never participates in comparisons.
 */
async function restoreMacosSnapshot(
  original: PosixSystemProxySnapshot,
  target: PosixSystemProxySnapshot,
): Promise<SystemProxyRestoreResult> {
  const originalServices = readServices(original.values);
  const targetServices = readServices(target.values);
  const { byUuid } = await serviceIdMap();
  const liveNames = new Set(byUuid.values());
  const skipped: SystemProxyRestoreSkip[] = [];
  const restorable: { service: string; values: ServiceProxyValues }[] = [];
  for (const [key, originalValues] of Object.entries(originalServices)) {
    const targetValues = targetServices[key];
    const service = byUuid.get(key) ?? (liveNames.has(key) ? key : undefined);
    if (!service) {
      skipped.push({ key, service: originalValues.serviceName, reason: "removed" });
      continue;
    }
    const current = await captureService(service);
    if (!current) {
      skipped.push({ key, service, reason: "modified" });
      continue;
    }
    // Leaf-granularity check: `-setwebproxy` writes host/port AND implicitly
    // enables, so a service left mid-write legitimately holds a mix of
    // original and target values. Every leaf must be either the recorded
    // original or the recorded target; anything else is an outside change
    // and the whole service is skipped, never overwritten.
    const currentRecord = current as unknown as Record<string, unknown>;
    const originalRecord = originalValues as unknown as Record<string, unknown>;
    const targetRecord = (targetValues ?? {}) as unknown as Record<string, unknown>;
    const fieldKeys = new Set([...Object.keys(originalRecord), ...Object.keys(targetRecord)]);
    let needsRestore = false;
    let externallyModified = false;
    const same = (a: unknown, b: unknown) =>
      JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const objectOf = (value: unknown): Record<string, unknown> =>
      isPlainObject(value) ? (value as Record<string, unknown>) : {};
    const walk = (now: unknown, was: unknown, want: unknown): void => {
      if (externallyModified) return;
      if (isPlainObject(now) || isPlainObject(was) || isPlainObject(want)) {
        if (!isPlainObject(now)) {
          externallyModified = true;
          return;
        }
        const subKeys = new Set([
          ...Object.keys(objectOf(now)),
          ...Object.keys(objectOf(was)),
          ...Object.keys(objectOf(want)),
        ]);
        for (const subKey of subKeys) {
          walk(objectOf(now)[subKey], objectOf(was)[subKey], objectOf(want)[subKey]);
        }
        return;
      }
      if (same(now, was)) return;
      if (same(now, want)) {
        needsRestore = true;
        return;
      }
      externallyModified = true;
    };
    for (const field of fieldKeys) {
      if (field === "serviceName") continue;
      walk(currentRecord[field], originalRecord[field], targetRecord[field]);
    }
    if (externallyModified) {
      skipped.push({ key, service, reason: "modified" });
      continue;
    }
    if (needsRestore) restorable.push({ service, values: originalValues });
  }
  for (const { service, values } of restorable) {
    await writeServiceProxy(service, values);
  }
  for (const { service, values } of restorable) {
    const after = await captureService(service);
    if (!after || proxyStateKey(after) !== proxyStateKey(values)) {
      throw new Error(`System proxy restoration verification failed for ${service}`);
    }
  }
  return { skipped };
}

function readServices(values: Record<string, unknown>): MacosServices {
  const raw = isPlainObject(values.services) ? (values.services as Record<string, unknown>) : {};
  const services: MacosServices = {};
  for (const [service, entry] of Object.entries(raw)) {
    if (!isPlainObject(entry)) continue;
    const manual = (value: unknown): ManualProxyValues => {
      const object = isPlainObject(value) ? value : {};
      return {
        enabled: object.enabled === true,
        server: typeof object.server === "string" ? object.server : "",
        port: typeof object.port === "number" ? object.port : 0,
        authenticated: object.authenticated === true,
      };
    };
    const auto = isPlainObject(entry.autoProxyUrl) ? entry.autoProxyUrl : {};
    const discovery = isPlainObject(entry.autoProxyDiscovery) ? entry.autoProxyDiscovery : {};
    services[service] = {
      serviceName: typeof entry.serviceName === "string" ? entry.serviceName : service,
      webProxy: manual(entry.webProxy),
      secureWebProxy: manual(entry.secureWebProxy),
      socksProxy: manual(entry.socksProxy),
      autoProxyUrl: {
        enabled: auto.enabled === true,
        url: typeof auto.url === "string" ? auto.url : "",
      },
      autoProxyDiscovery: { enabled: discovery.enabled === true },
      bypass: Array.isArray(entry.bypass)
        ? entry.bypass.filter((item): item is string => typeof item === "string")
        : [],
    };
  }
  return services;
}

function canonical(snapshot: SystemProxySnapshot): string {
  const services = readServices(snapshot.platform === "darwin" ? snapshot.values : {});
  const sorted = Object.keys(services)
    .sort()
    .map((name) => [name, services[name]]);
  return JSON.stringify(sorted);
}

export const macosSystemProxySnapshotCodec: SystemProxySnapshotCodec = {
  parse(value) {
    if (!isPlainObject(value)) throw new Error("Invalid macOS system proxy snapshot");
    const platform = value.platform;
    if (platform !== "darwin") {
      throw new Error(`Expected a darwin system proxy snapshot, got ${String(platform)}`);
    }
    const values = isPlainObject(value.values) ? value.values : {};
    return {
      version: SYSTEM_PROXY_SNAPSHOT_VERSION,
      platform: "darwin",
      values: { services: readServices(values) },
    };
  },
  equivalent(left, right) {
    if (left.platform !== "darwin" || right.platform !== "darwin") return left === right;
    return canonical(left) === canonical(right);
  },
  compatible(current, original, target) {
    if (
      current.platform !== "darwin" ||
      original.platform !== "darwin" ||
      target.platform !== "darwin"
    ) {
      return false;
    }
    const currentServices = readServices(current.values as Record<string, unknown>);
    const originalServices = readServices(original.values as Record<string, unknown>);
    const targetServices = readServices(target.values as Record<string, unknown>);
    for (const [service, fields] of Object.entries(targetServices)) {
      const currentService = currentServices[service];
      const originalService = originalServices[service];
      if (!currentService) continue;
      for (const [key, targetValue] of Object.entries(fields)) {
        // serviceName is identity metadata, not proxy state: a rename must
        // not veto restoring the values we set.
        if (key === "serviceName") continue;
        const now = JSON.stringify(
          (currentService as unknown as Record<string, unknown>)[key] ?? null,
        );
        const was = JSON.stringify(
          (originalService as unknown as Record<string, unknown> | undefined)?.[key] ?? null,
        );
        const want = JSON.stringify(targetValue ?? null);
        if (now !== was && now !== want) return false;
      }
    }
    return true;
  },
  target(options: EnableOptions, original: SystemProxySnapshot) {
    const host = options.host ?? "127.0.0.1";
    const bypass = options.bypass ?? [...DEFAULT_BYPASS_LIST];
    const services = readServices(
      original.platform === "darwin" ? (original.values as Record<string, unknown>) : {},
    );
    const target: MacosServices = {};
    for (const [service, originalService] of Object.entries(services)) {
      target[service] = {
        serviceName: originalService.serviceName,
        webProxy: { enabled: true, server: host, port: options.port, authenticated: false },
        secureWebProxy: { enabled: true, server: host, port: options.port, authenticated: false },
        socksProxy: { enabled: true, server: host, port: options.port, authenticated: false },
        // Disabled PAC keeps its stored URL: only the state bit changes, so
        // the target equals what the machine will actually hold.
        autoProxyUrl: { enabled: false, url: originalService.autoProxyUrl.url },
        autoProxyDiscovery: { enabled: false },
        bypass,
      };
    }
    return {
      version: SYSTEM_PROXY_SNAPSHOT_VERSION,
      platform: "darwin",
      values: { services: target },
    };
  },
  state(snapshot): SystemProxyState {
    if (snapshot.platform !== "darwin") return { supported: false, enabled: false };
    const services = readServices(snapshot.values as Record<string, unknown>);
    for (const values of Object.values(services)) {
      for (const manual of [values.webProxy, values.secureWebProxy, values.socksProxy]) {
        if (manual.enabled && manual.server) {
          return {
            supported: true,
            enabled: true,
            server: formatHostPort(manual.server, manual.port),
          };
        }
      }
      if (values.autoProxyUrl.enabled && values.autoProxyUrl.url) {
        return { supported: true, enabled: true, details: values.autoProxyUrl.url };
      }
    }
    return { supported: true, enabled: false };
  },
};

export function asMacosSnapshot(snapshot: SystemProxySnapshot): PosixSystemProxySnapshot {
  if (snapshot.platform !== "darwin") throw new Error("Expected a macOS system proxy snapshot");
  return snapshot;
}

export function macosSystemProxyBackend(): SystemProxyBackend {
  return {
    supported: true,
    snapshot: macosSystemProxySnapshotCodec,
    capture: captureMacosSnapshot,
    apply: (snapshot) => applyMacosSnapshot(asMacosSnapshot(snapshot)),
    restore: (original, target) =>
      restoreMacosSnapshot(asMacosSnapshot(original), asMacosSnapshot(target)),
  };
}
