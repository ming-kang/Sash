import {
  compareStrings,
  errorMessage,
  formatHostPort,
  normalizeEnableOptions,
  parseProxyString,
  parseServiceName,
  runCmd,
} from "./common.js";
import { darwinSnapshot } from "./snapshot.js";
import type {
  DarwinAutoProxySetting,
  DarwinProxySetting,
  DarwinServiceProxySnapshot,
  DarwinSystemProxySnapshot,
  EnableOptions,
  SystemProxySnapshot,
  SystemProxyState,
} from "./types.js";
import { SYSTEM_PROXY_SNAPSHOT_VERSION } from "./types.js";

export function parseDarwinServices(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("*") && !line.startsWith("An asterisk"));
}

interface ParsedDarwinProxyOutput {
  enabled?: boolean;
  server?: string;
  port?: number;
  authenticated?: boolean;
}

function getDarwinOutputValue(output: string, label: string): string | undefined {
  const prefix = `${label}:`;
  const lowerCasePrefix = prefix.toLowerCase();
  for (const line of output.split(/\r\n?|\n/)) {
    if (line.slice(0, prefix.length).toLowerCase() === lowerCasePrefix) {
      return line.slice(prefix.length).replace(/^[^\S\r\n]+|[^\S\r\n]+$/g, "");
    }
  }
  return undefined;
}

function parseDarwinProxyOutput(output: string): ParsedDarwinProxyOutput {
  const enabledText = getDarwinOutputValue(output, "Enabled")?.toLowerCase();
  const server = getDarwinOutputValue(output, "Server");
  const portText = getDarwinOutputValue(output, "Port");
  const authenticatedText = getDarwinOutputValue(
    output,
    "Authenticated Proxy Enabled",
  )?.toLowerCase();

  let enabled: boolean | undefined;
  if (enabledText === "yes") enabled = true;
  if (enabledText === "no") enabled = false;

  let port: number | undefined;
  if (portText !== undefined && /^\d+$/.test(portText)) {
    const parsed = Number.parseInt(portText, 10);
    if (parsed >= 0 && parsed <= 65_535) port = parsed;
  }

  let authenticated: boolean | undefined;
  if (authenticatedText === "yes" || authenticatedText === "on" || authenticatedText === "1") {
    authenticated = true;
  }
  if (authenticatedText === "no" || authenticatedText === "off" || authenticatedText === "0") {
    authenticated = false;
  }

  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(server === undefined ? {} : { server }),
    ...(port === undefined ? {} : { port }),
    ...(authenticated === undefined ? {} : { authenticated }),
  };
}

/** Legacy display parser retained for existing callers. */
export function parseDarwinGetWebProxy(output: string): { enabled: boolean; server?: string } {
  const parsed = parseDarwinProxyOutput(output);
  const enabled = parsed.enabled === true;
  if (!enabled || !parsed.server || !parsed.port) return { enabled };
  return { enabled, server: `${parsed.server}:${parsed.port}` };
}

/** Parse the complete networksetup proxy record needed for lossless recovery. */
export function parseDarwinProxySetting(output: string): DarwinProxySetting {
  const parsed = parseDarwinProxyOutput(output);
  if (parsed.enabled === undefined) {
    throw new Error("Invalid macOS networksetup output: missing Enabled state");
  }
  if (parsed.server === undefined) {
    throw new Error("Invalid macOS networksetup output: missing Server value");
  }
  if (parsed.port === undefined) {
    throw new Error("Invalid macOS networksetup output: missing or invalid Port value");
  }
  if (parsed.authenticated === undefined) {
    throw new Error("Invalid macOS networksetup output: missing authenticated proxy state");
  }
  return {
    enabled: parsed.enabled,
    server: parseProxyString(parsed.server, "macOS proxy server"),
    port: parsed.port,
    authenticated: parsed.authenticated,
  };
}

export function parseDarwinAutoProxySetting(output: string): DarwinAutoProxySetting {
  const enabledText = getDarwinOutputValue(output, "Enabled")?.toLowerCase();
  const urlText = getDarwinOutputValue(output, "URL");
  if (enabledText !== "yes" && enabledText !== "no") {
    throw new Error("Invalid macOS networksetup output: missing automatic proxy state");
  }
  if (urlText === undefined) {
    throw new Error("Invalid macOS networksetup output: missing automatic proxy URL");
  }
  return {
    enabled: enabledText === "yes",
    url: parseProxyString(urlText === "(null)" ? "" : urlText, "macOS automatic proxy URL"),
  };
}

function listDarwinServices(): string[] {
  const services = parseDarwinServices(runCmd("networksetup", ["-listallnetworkservices"]));
  const canonical = services.map((service, index) =>
    parseServiceName(service, `network service ${index}`),
  );
  canonical.sort(compareStrings);
  for (let index = 1; index < canonical.length; index++) {
    if (canonical[index - 1] === canonical[index]) {
      throw new Error("Invalid macOS networksetup output: duplicate network service name");
    }
  }
  return canonical;
}

type DarwinProxyKind = "web" | "secureWeb" | "socks";

const DARWIN_PROXY_COMMANDS: ReadonlyArray<{
  kind: DarwinProxyKind;
  set: string;
  setState: string;
  get: string;
}> = [
  {
    kind: "web",
    set: "-setwebproxy",
    setState: "-setwebproxystate",
    get: "-getwebproxy",
  },
  {
    kind: "secureWeb",
    set: "-setsecurewebproxy",
    setState: "-setsecurewebproxystate",
    get: "-getsecurewebproxy",
  },
  {
    kind: "socks",
    set: "-setsocksfirewallproxy",
    setState: "-setsocksfirewallproxystate",
    get: "-getsocksfirewallproxy",
  },
];

export function captureDarwinSnapshot(): DarwinSystemProxySnapshot {
  const services = listDarwinServices().map((service): DarwinServiceProxySnapshot => {
    const settings = new Map<DarwinProxyKind, DarwinProxySetting>();
    for (const command of DARWIN_PROXY_COMMANDS) {
      settings.set(
        command.kind,
        parseDarwinProxySetting(runCmd("networksetup", [command.get, service])),
      );
    }
    const web = settings.get("web");
    const secureWeb = settings.get("secureWeb");
    const socks = settings.get("socks");
    if (!web || !secureWeb || !socks) {
      throw new Error("Failed to capture all macOS proxy protocols");
    }
    const auto = parseDarwinAutoProxySetting(runCmd("networksetup", ["-getautoproxyurl", service]));
    return { service, web, secureWeb, socks, auto };
  });
  return {
    version: SYSTEM_PROXY_SNAPSHOT_VERSION,
    platform: "darwin",
    services,
  };
}

function assertNoAuthenticatedDarwinProxy(snapshot: DarwinSystemProxySnapshot): void {
  for (const service of snapshot.services) {
    for (const command of DARWIN_PROXY_COMMANDS) {
      if (service[command.kind].authenticated) {
        throw new Error(
          `Cannot safely take over macOS proxy for ${JSON.stringify(service.service)}: ${command.kind} uses an authenticated proxy whose credentials cannot be restored`,
        );
      }
    }
  }
}

export function applyDarwinSnapshot(value: unknown): void {
  const snapshot = darwinSnapshot(value);
  assertNoAuthenticatedDarwinProxy(snapshot);

  const activeServices = listDarwinServices();
  const snapshotServices = snapshot.services.map((service) => service.service);
  if (
    activeServices.length !== snapshotServices.length ||
    activeServices.some((service, index) => service !== snapshotServices[index])
  ) {
    throw new Error(
      "macOS network service collection changed; refusing to apply a stale proxy snapshot",
    );
  }

  const failures: string[] = [];
  for (const service of snapshot.services) {
    for (const command of DARWIN_PROXY_COMMANDS) {
      const setting = service[command.kind];
      try {
        runCmd("networksetup", [
          command.set,
          service.service,
          setting.server,
          String(setting.port),
        ]);
      } catch (err) {
        failures.push(
          `${JSON.stringify(service.service)} ${command.kind} server/port: ${errorMessage(err)}`,
        );
      }
    }
    if (service.auto.url) {
      try {
        runCmd("networksetup", ["-setautoproxyurl", service.service, service.auto.url]);
      } catch (err) {
        failures.push(
          `${JSON.stringify(service.service)} automatic proxy URL: ${errorMessage(err)}`,
        );
      }
    }

    const stateOperations = [
      ...DARWIN_PROXY_COMMANDS.map((command) => ({
        label: command.kind,
        command: command.setState,
        enabled: service[command.kind].enabled,
      })),
      {
        label: "automatic proxy",
        command: "-setautoproxystate",
        enabled: service.auto.enabled,
      },
    ];
    // Turn unwanted modes off before enabling the selected modes. This avoids
    // a transition where stale PAC and manual proxy settings are active together.
    for (const operation of [
      ...stateOperations.filter((item) => !item.enabled),
      ...stateOperations.filter((item) => item.enabled),
    ]) {
      try {
        runCmd("networksetup", [
          operation.command,
          service.service,
          operation.enabled ? "on" : "off",
        ]);
      } catch (err) {
        failures.push(
          `${JSON.stringify(service.service)} ${operation.label} state: ${errorMessage(err)}`,
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to apply macOS system proxy settings: ${failures.join("; ")}`);
  }
}

export function createDarwinTarget(
  original: SystemProxySnapshot,
  opts: EnableOptions,
): DarwinSystemProxySnapshot {
  const snapshot = darwinSnapshot(original);
  assertNoAuthenticatedDarwinProxy(snapshot);
  if (snapshot.services.length === 0) {
    throw new Error("Cannot enable macOS system proxy: no active network services found");
  }
  const normalized = normalizeEnableOptions(opts);
  const targetSetting = (): DarwinProxySetting => ({
    enabled: true,
    server: normalized.host,
    port: normalized.port,
    authenticated: false,
  });
  return {
    version: SYSTEM_PROXY_SNAPSHOT_VERSION,
    platform: "darwin",
    services: snapshot.services.map((service) => ({
      service: service.service,
      web: targetSetting(),
      secureWeb: targetSetting(),
      socks: targetSetting(),
      auto: { ...service.auto, enabled: false },
    })),
  };
}

export function darwinState(value: unknown): SystemProxyState {
  const snapshot = darwinSnapshot(value);
  if (snapshot.services.length === 0) {
    return { supported: true, enabled: false, details: "no active network services found" };
  }

  const enabledSettings: DarwinProxySetting[] = [];
  const enabledAutoUrls: string[] = [];
  for (const service of snapshot.services) {
    for (const command of DARWIN_PROXY_COMMANDS) {
      const setting = service[command.kind];
      if (setting.enabled) enabledSettings.push(setting);
    }
    if (service.auto.enabled) enabledAutoUrls.push(service.auto.url);
  }
  if (enabledSettings.length === 0 && enabledAutoUrls.length === 0) {
    return { supported: true, enabled: false };
  }
  if (enabledSettings.length === 0) {
    const urls = new Set(enabledAutoUrls.filter(Boolean));
    return {
      supported: true,
      enabled: true,
      ...(urls.size === 1 ? { server: urls.values().next().value } : {}),
      details: "automatic proxy configuration is enabled",
    };
  }

  const endpoints = new Set<string>();
  let hasIncompleteEndpoint = false;
  for (const setting of enabledSettings) {
    if (!setting.server || setting.port === 0) {
      hasIncompleteEndpoint = true;
      continue;
    }
    endpoints.add(formatHostPort(setting.server, setting.port));
  }
  if (endpoints.size === 1 && !hasIncompleteEndpoint && enabledAutoUrls.length === 0) {
    const server = endpoints.values().next().value;
    return typeof server === "string"
      ? { supported: true, enabled: true, server }
      : { supported: true, enabled: true };
  }
  return {
    supported: true,
    enabled: true,
    details:
      enabledAutoUrls.length > 0
        ? "manual and automatic proxy settings are both active"
        : "multiple or incomplete active proxy settings",
  };
}
