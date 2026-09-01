import { formatHostPort, normalizeEnableOptions } from "./common.js";
import { createSystemProxyBackend } from "./factory.js";
import { parseSystemProxySnapshot } from "./snapshot.js";
import type { DarwinProxySetting, EnableOptions, SystemProxySnapshot } from "./types.js";

/**
 * Build the narrow cleanup used when migrating a pre-journal daemon. It only
 * disables manual proxy fields that still point exactly at Sash's loopback
 * target and never changes a third-party endpoint or automatic proxy value.
 */
export function createLegacyProxyCleanup(
  value: unknown,
  opts: EnableOptions,
): SystemProxySnapshot | undefined {
  const snapshot = parseSystemProxySnapshot(value);
  const normalized = normalizeEnableOptions(opts);
  const target = formatHostPort(normalized.host, normalized.port);

  switch (snapshot.platform) {
    case "win32":
      return snapshot.proxyEnable === 1 && snapshot.proxyServer === target
        ? { ...snapshot, proxyEnable: 0 }
        : undefined;
    case "darwin": {
      let matched = false;
      let conflict = false;
      const clean = (setting: DarwinProxySetting): DarwinProxySetting => {
        if (!setting.enabled) return setting;
        if (formatHostPort(setting.server, setting.port) !== target) {
          conflict = true;
          return setting;
        }
        matched = true;
        return { ...setting, enabled: false };
      };
      const services = snapshot.services.map((service) => ({
        ...service,
        web: clean(service.web),
        secureWeb: clean(service.secureWeb),
        socks: clean(service.socks),
      }));
      if (!matched || conflict) return undefined;
      return { ...snapshot, services };
    }
    case "linux":
      if (
        snapshot.mode !== "manual" ||
        [snapshot.http, snapshot.https, snapshot.socks].some(
          (endpoint) => formatHostPort(endpoint.host, endpoint.port) !== target,
        )
      ) {
        return undefined;
      }
      return { ...snapshot, mode: "none" };
  }
}

export async function disableLegacySystemProxyIfOwned(opts: EnableOptions): Promise<boolean> {
  const backend = createSystemProxyBackend();
  if (backend.supported === false) return false;
  const current = backend.capture();
  const cleanup = createLegacyProxyCleanup(current, opts);
  if (!cleanup) return false;
  backend.apply(cleanup);
  const verified = backend.capture();
  if (!backend.equivalent(verified, cleanup)) {
    throw new Error("Legacy system proxy cleanup could not be verified");
  }
  return true;
}
