/** Windows registry adapter and the shared system-proxy contract. */
export { isSystemProxySupported } from "./sysproxy/common.js";
export { createSystemProxyBackend } from "./sysproxy/factory.js";
export { parseSystemProxySnapshot } from "./sysproxy/snapshot.js";
export type {
  EnableOptions,
  SystemProxyBackend,
  SystemProxySnapshot,
  SystemProxyState,
  WindowsRegistryProxyValues,
  WindowsSystemProxySnapshot,
} from "./sysproxy/types.js";
export { DEFAULT_BYPASS_LIST, SYSTEM_PROXY_SNAPSHOT_VERSION } from "./sysproxy/types.js";
export { formatWindowsBypass, parseWindowsRegistryProxyValues } from "./sysproxy/windows.js";
