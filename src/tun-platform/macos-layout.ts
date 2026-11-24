import path from "node:path";

/**
 * Protected locations for the macOS privileged TUN helper. Everything under
 * SASH_SUPPORT_DIR is owned by root:wheel and installed through an elevated
 * (osascript) script; the helper itself runs as a LaunchDaemon.
 */
export const SASH_SUPPORT_DIR = "/Library/Application Support/Sash";
export const HELPER_LABEL = "dev.astralyn.sash.helper";
export const LAUNCH_DAEMON_PLIST = `/Library/LaunchDaemons/${HELPER_LABEL}.plist`;
/** Root:wheel 0755 — the helper executable and digest-named Core binaries. */
export const PROTECTED_BIN_DIR = path.join(SASH_SUPPORT_DIR, "bin");
export const HELPER_BIN = path.join(PROTECTED_BIN_DIR, "sash-helper");
/** Root:wheel 0700 — the Core's private working directory (config, cache.db). */
export const PROTECTED_WORK_DIR = path.join(SASH_SUPPORT_DIR, "work");
/** owner-uid:staff 0700 — unix socket directory reachable only by the installer. */
export const HELPER_RUN_DIR = path.join(SASH_SUPPORT_DIR, "run");
export const HELPER_SOCKET = path.join(HELPER_RUN_DIR, "helper.sock");
export const HELPER_META_FILE = path.join(SASH_SUPPORT_DIR, "helper.json");
export const HELPER_LOG_OUT = path.join(SASH_SUPPORT_DIR, "helper.out.log");
export const HELPER_LOG_ERR = path.join(SASH_SUPPORT_DIR, "helper.err.log");
