/**
 * Platform-level system proxy backend.
 *
 * Higher-level ownership and recovery policy lives in system-proxy-manager.ts.
 * This public entry keeps the established ./sysproxy.js API stable while the
 * platform implementations live in focused submodules.
 */

export { isSystemProxySupported } from "./sysproxy/common.js";
export {
  parseDarwinAutoProxySetting,
  parseDarwinGetWebProxy,
  parseDarwinProxySetting,
  parseDarwinServices,
} from "./sysproxy/darwin.js";
export { createSystemProxyBackend } from "./sysproxy/factory.js";
export { parseGSettingsPort, parseGSettingsString } from "./sysproxy/gnome.js";
export {
  createLegacyProxyCleanup,
  disableLegacySystemProxyIfOwned,
} from "./sysproxy/legacy.js";
export { isSystemProxySnapshot, parseSystemProxySnapshot } from "./sysproxy/snapshot.js";
export type {
  DarwinAutoProxySetting,
  DarwinProxySetting,
  DarwinServiceProxySnapshot,
  DarwinSystemProxySnapshot,
  EnableOptions,
  LinuxProxyEndpoint,
  LinuxProxyMode,
  LinuxSystemProxySnapshot,
  SystemProxyBackend,
  SystemProxyPlatform,
  SystemProxySnapshot,
  SystemProxyState,
  WindowsRegistryProxyValues,
  WindowsSystemProxySnapshot,
} from "./sysproxy/types.js";
export { DEFAULT_BYPASS_LIST, SYSTEM_PROXY_SNAPSHOT_VERSION } from "./sysproxy/types.js";
export {
  formatWindowsBypass,
  parseWindowsRegistryProxyValues,
  parseWindowsRegQuery,
} from "./sysproxy/windows.js";
