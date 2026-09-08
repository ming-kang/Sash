import os from "node:os";
import path from "node:path";

/**
 * Sash manages one canonical local Mihomo instance. The root directory follows
 * per-platform data dir conventions; SASH_HOME may override it when absolute.
 */

function envPathOr(fallback: string, value: string | undefined): string {
  const trimmed = value?.trim();
  // Per XDG spec: non-absolute paths must be ignored to avoid cwd-dependent drift.
  return trimmed && path.isAbsolute(trimmed) ? trimmed : fallback;
}

export function sashRoot(): string {
  const override = process.env.SASH_HOME?.trim();
  if (override) {
    if (!path.isAbsolute(override)) {
      throw new Error(`SASH_HOME must be an absolute path, got: ${override}`);
    }
    return override;
  }
  if (process.platform === "win32") {
    const base = envPathOr(path.join(os.homedir(), "AppData", "Local"), process.env.LOCALAPPDATA);
    return path.join(base, "Sash");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Sash");
  }
  const xdgData = envPathOr(path.join(os.homedir(), ".local", "share"), process.env.XDG_DATA_HOME);
  return path.join(xdgData, "sash");
}

export interface SashLayout {
  root: string;
  binDir: string;
  coreExe: string;
  configFile: string;
  settingsFile: string;
  profilesDir: string;
  uiDir: string;
  stateDir: string;
  pidFile: string;
  daemonPidFile: string;
  daemonLeaseFile: string;
  daemonStartLockFile: string;
  systemProxyStateFile: string;
  systemProxyLockFile: string;
  installFile: string;
  coreUpdateTransactionFile: string;
  logsDir: string;
  coreLogFile: string;
  coreErrLogFile: string;
  sashLogFile: string;
  daemonLogFile: string;
  daemonErrLogFile: string;
  tempDir: string;
}

export function sashLayout(root: string = sashRoot()): SashLayout {
  const exeName = process.platform === "win32" ? "mihomo.exe" : "mihomo";
  const userControlDir =
    process.platform === "win32"
      ? path.join(
          envPathOr(path.join(os.homedir(), "AppData", "Local"), process.env.LOCALAPPDATA),
          "Sash",
        )
      : path.join(root, "state");
  return {
    root,
    binDir: path.join(root, "bin"),
    coreExe: path.join(root, "bin", exeName),
    configFile: path.join(root, "runtime", "config.yaml"),
    settingsFile: path.join(root, "sash.json"),
    profilesDir: path.join(root, "profiles"),
    uiDir: path.join(root, "ui"),
    stateDir: path.join(root, "state"),
    pidFile: path.join(root, "state", "sash.pid"),
    daemonPidFile: path.join(root, "state", "sashd.pid"),
    daemonLeaseFile: path.join(root, "state", "sashd.lock"),
    daemonStartLockFile: path.join(root, "state", "sashd-start.lock"),
    systemProxyStateFile: path.join(root, "state", "system-proxy.json"),
    systemProxyLockFile: path.join(userControlDir, "system-proxy.lock"),
    installFile: path.join(root, "state", "install.json"),
    coreUpdateTransactionFile: path.join(root, "state", "core-update-transaction.json"),
    logsDir: path.join(root, "logs"),
    coreLogFile: path.join(root, "logs", "mihomo.log"),
    coreErrLogFile: path.join(root, "logs", "mihomo.err.log"),
    sashLogFile: path.join(root, "logs", "sash.log"),
    daemonLogFile: path.join(root, "logs", "sashd.log"),
    daemonErrLogFile: path.join(root, "logs", "sashd.err.log"),
    tempDir: path.join(root, "temp"),
  };
}
