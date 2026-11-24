import path from "node:path";

/**
 * Linux helper layout. The bin directory holds only root-owned, verified
 * executables and receipts; the work directory is the writable Core runtime
 * directory (rendered config, controller socket, network journal).
 */
export const LINUX_HELPER_BIN_DIR = "/usr/local/lib/sash";
export const LINUX_HELPER_BINARY = path.join(LINUX_HELPER_BIN_DIR, "sash-helper");
export const LINUX_HELPER_MANIFEST = path.join(LINUX_HELPER_BIN_DIR, "install-manifest.json");
export const LINUX_HELPER_WORK_DIR = "/var/lib/sash-helper";
export const LINUX_HELPER_UNIT_FILE = "/etc/systemd/system/sash-helper.service";
export const LINUX_HELPER_RUNTIME_DIR = "/run/sash-helper";
export const LINUX_HELPER_SOCKET = path.join(LINUX_HELPER_RUNTIME_DIR, "helper.sock");
