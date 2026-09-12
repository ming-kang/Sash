import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { readState, type SashState } from "./app-state.js";
import { readLoginStartRecord } from "./autostart/login-record.js";
import { CORE_BINARY_SIZE_LIMIT, readInstallRecord } from "./core.js";
import { GEODATA_FILE_NAMES } from "./core-config-validation.js";
import { errorMessage } from "./error-utils.js";
import { pathEntryExists } from "./fs-atomic.js";
import { fetchWithRetry } from "./http.js";
import { currentPackageRoot, readSashPackageInfo, supportsNode } from "./package-info.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { inspectInstallation } from "./sash-installation.js";
import { DEFAULT_SETTINGS, parseControllerAddress } from "./settings.js";
import {
  type CliRuntimeStatus,
  collectRuntimeStatus,
  formatAutostart,
  formatSystemProxyLine,
  type StatusObservationDependencies,
} from "./status.js";
import {
  inspectWindowsProxyConnections,
  type ProxyConnectionsObservation,
} from "./sysproxy/windows-connections.js";

export interface DoctorCheck {
  id: string;
  status: "ok" | "info" | "warning" | "error";
  message: string;
  advice?: string;
}
export interface DoctorReport {
  schemaVersion: 1;
  healthy: boolean;
  complete: boolean;
  checks: DoctorCheck[];
}
export interface PortObservation {
  available: boolean;
  reason?: string;
  unknown?: boolean;
}

/** Bind briefly to a stopped listener's address; no application traffic is sent. */
export function inspectListenerPort(host: string, port: number): Promise<PortObservation> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.destroy());
    let finished = false;
    const finish = (result: PortObservation): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ available: false, unknown: true, reason: "Port inspection timed out" });
      if (server.listening) server.close();
    }, 2000);
    server.once("error", (error: NodeJS.ErrnoException) =>
      finish({
        available: false,
        unknown: error.code !== "EADDRINUSE",
        reason: error.code ?? error.message,
      }),
    );
    server.listen({ host, port, exclusive: true }, () =>
      server.close(() => finish({ available: true })),
    );
  });
}

const NETWORK_PROBES = [
  { name: "github.com", url: "https://github.com" },
  { name: "api.github.com", url: "https://api.github.com" },
  { name: "ghfast.top", url: "https://ghfast.top" },
] as const;

/** Any HTTP response counts as reachable; only transport failures count as unreachable. */
async function probeHttpReachability(url: string): Promise<boolean> {
  try {
    const res = await fetchWithRetry(url, { attempts: 1, deadlineMs: 5_000 });
    await res.discard();
    return true;
  } catch {
    return false;
  }
}

/** Independent checks keep diagnostics useful when settings or installation files are damaged. */
export async function diagnoseSash(
  options: {
    layout?: SashLayout;
    packageRoot?: string;
    status?: StatusObservationDependencies;
    inspectPort?: typeof inspectListenerPort;
    inspectProxyConnections?: () => Promise<ProxyConnectionsObservation>;
    probeReachability?: (url: string) => Promise<boolean>;
  } = {},
): Promise<DoctorReport> {
  const layout = options.layout ?? sashLayout();
  const packageRoot = options.packageRoot ?? currentPackageRoot();
  const checks: DoctorCheck[] = [];
  const add = (
    id: string,
    status: DoctorCheck["status"],
    message: string,
    advice?: string,
  ): void => {
    checks.push({ id, status, message, ...(advice ? { advice } : {}) });
  };
  const installation = inspectInstallation({ packageRoot });
  add(
    "installation",
    installation.kind === "unknown"
      ? "warning"
      : installation.kind === "npm-global"
        ? "ok"
        : "info",
    installation.kind === "npm-global"
      ? `Global npm installation: ${installation.prefix}`
      : installation.reason,
  );
  let installedVersion: string | undefined;
  try {
    const info = readSashPackageInfo(packageRoot);
    installedVersion = info.version;
    add(
      "node",
      supportsNode(info) ? "ok" : "error",
      `Node ${process.version}; Sash ${info.version} requires ${info.nodeRange}`,
      supportsNode(info) ? undefined : "Use a Node executable supported by this Sash release",
    );
  } catch (error) {
    add(
      "node",
      "error",
      errorMessage(error),
      "Repair the Sash package through its installation method",
    );
  }
  try {
    for (const entry of [
      "dist/cli.js",
      "dist/daemon-entry.js",
      "dist/ui/index.html",
      "package.json",
    ]) {
      if (!fs.statSync(path.join(packageRoot, entry)).isFile()) {
        throw new Error(`Missing ${entry} in ${packageRoot}`);
      }
    }
    add("dashboard", "ok", "Bundled dashboard and command entries are present");
  } catch (error) {
    add(
      "dashboard",
      "error",
      errorMessage(error),
      installation.kind === "source"
        ? "Run npm run build in the source checkout"
        : "Stop affected instances and reinstall the Sash package",
    );
  }

  let state: SashState | undefined;
  let stateValid = true;
  try {
    state = readState(layout);
    add(
      "manifest",
      state ? "ok" : "info",
      state
        ? `Settings are readable: ${layout.settingsFile}`
        : `No settings yet in this folder: ${layout.settingsFile}`,
      state ? undefined : "Run sash start or sash web to create them",
    );
  } catch (error) {
    stateValid = false;
    add(
      "manifest",
      "error",
      `${layout.settingsFile}: ${errorMessage(error)}`,
      pathEntryExists(layout.settingsBackupFile)
        ? `Stop Sash, then copy ${layout.settingsBackupFile} over ${layout.settingsFile} to restore the most recently committed settings and profile index`
        : "Preserve the file and restore a valid schema-2 manifest before starting Sash",
    );
  }
  try {
    const binary = pathEntryExists(layout.coreExe);
    const metadata = pathEntryExists(layout.installFile);
    const record = readInstallRecord(layout);
    const binaryStat = binary ? fs.lstatSync(layout.coreExe) : undefined;
    if (!binary && !metadata)
      add("core", "info", "Core is not installed", "Run sash start to install Core");
    else if (
      !binaryStat?.isFile() ||
      binaryStat.size === 0 ||
      binaryStat.size > CORE_BINARY_SIZE_LIMIT ||
      !record
    )
      add(
        "core",
        "error",
        `The Core binary and its install record disagree: ${layout.coreExe}`,
        "Preserve existing files, stop the instance and inspect its install record before reinstalling",
      );
    else add("core", "ok", `Core ${record.coreVersion} is installed`);
  } catch (error) {
    add(
      "core",
      "error",
      errorMessage(error),
      "Inspect the executable and install record before reinstalling Core",
    );
  }

  try {
    const present = GEODATA_FILE_NAMES.filter((name) =>
      pathEntryExists(path.join(layout.root, name)),
    );
    if (present.length === 0) {
      add(
        "geodata",
        "info",
        "geodata is not downloaded yet",
        "The Core downloads its databases on first start; on an offline machine place them in the data folder beforehand",
      );
    } else {
      add("geodata", "ok", `geodata present: ${present.join(", ")}`);
    }
  } catch (error) {
    add("geodata", "info", errorMessage(error));
  }

  {
    const probe = options.probeReachability ?? probeHttpReachability;
    const results = await Promise.all(
      NETWORK_PROBES.map(async ({ name, url }) => ({ name, reachable: await probe(url) })),
    );
    const reachable = results.filter((result) => result.reachable).map((result) => result.name);
    const unreachable = results.filter((result) => !result.reachable).map((result) => result.name);
    const releaseApiReachable = results.find(
      (result) => result.name === "api.github.com",
    )?.reachable;
    if (reachable.length === results.length) {
      add("network", "ok", `Core download sources are reachable: ${reachable.join(", ")}`);
    } else if (reachable.length === 0) {
      add(
        "network",
        "warning",
        "No Core download source is reachable",
        "Check your network or set HTTP_PROXY to a running proxy; a manual offline install is described in docs/usage.md",
      );
    } else if (releaseApiReachable !== true) {
      add(
        "network",
        "warning",
        "The GitHub release API is unreachable; Core downloads cannot be verified",
        "Set HTTP_PROXY to a running proxy, or retry when api.github.com is reachable",
      );
    } else {
      add("network", "ok", `Some Core download mirrors are unreachable: ${unreachable.join(", ")}`);
    }
  }

  if (stateValid) {
    const context = { layout, settings: state?.settings ?? { ...DEFAULT_SETTINGS } };
    let runtime: CliRuntimeStatus | undefined;
    try {
      runtime = await collectRuntimeStatus(context, options.status);
      add(
        "runtime",
        runtime.daemon.state === "unhealthy" ||
          (runtime.core.running === true && runtime.core.healthy !== true)
          ? "warning"
          : "ok",
        `Sash ${runtime.daemon.state === "healthy" ? "is running" : runtime.daemon.state === "stopped" ? "is not running" : "is not responding"} · Core ${runtime.core.running === null ? "unknown" : runtime.core.running ? "running" : "stopped"}`,
        runtime.daemon.state === "unhealthy"
          ? "Inspect sash logs --daemon --errors; do not stop an unverified process"
          : undefined,
      );
      // A daemon keeps executing the code it started with, so a difference here
      // means the installed package was replaced but not loaded yet.
      const runningVersion = runtime.daemon.version;
      if (runningVersion && installedVersion) {
        add(
          "sash-version",
          runningVersion === installedVersion ? "ok" : "warning",
          runningVersion === installedVersion
            ? `Sash ${runningVersion} is installed and running`
            : `Sash ${installedVersion} is installed; the daemon still runs ${runningVersion}`,
          runningVersion === installedVersion
            ? undefined
            : "Run sash stop && sash start to load the installed version",
        );
      }
      if (!state && runtime.daemon.running)
        add(
          "runtime-manifest",
          "error",
          "A running daemon has no readable saved manifest",
          "Restore the missing state and credentials from a backup before making management changes",
        );
      const proxy = runtime.systemProxy;
      add(
        "proxy",
        proxy.osObserved.enabled === null || proxy.daemonApplied === null ? "warning" : "ok",
        formatSystemProxyLine(proxy.desired, proxy.osObserved),
        runtime.queryError ?? undefined,
      );
      const auto = runtime.autostart;
      add(
        "autostart",
        auto.state === "unknown"
          ? "warning"
          : auto.state === "stale" || auto.state === "disabled"
            ? "error"
            : auto.state === "unsupported"
              ? "info"
              : "ok",
        formatAutostart(auto),
        auto.state === "stale" || auto.state === "disabled"
          ? "Run sash auto on to repair the entry, or sash auto off to remove it"
          : undefined,
      );
      if (auto.state === "on" || auto.state === "stale" || auto.state === "disabled") {
        const login = readLoginStartRecord(layout);
        if (!login) {
          add("login-start", "info", "no login start recorded yet");
        } else if (login.ok) {
          add("login-start", "ok", `last login start succeeded at ${login.at}`);
        } else {
          add(
            "login-start",
            "error",
            `last login start failed: ${login.error ?? "unknown error"}`,
            "Run sash logs for details, then sash start to verify the recovery",
          );
        }
      }
    } catch (error) {
      add("runtime", "warning", errorMessage(error), "Inspect sash status and the daemon logs");
    }

    if (state || !runtime?.daemon.running) {
      const controller = parseControllerAddress(context.settings.controller);
      if (controller) {
        const ports = [
          {
            id: "daemon-port",
            host: "127.0.0.1",
            port: context.settings.daemonPort,
            owned:
              runtime?.daemon.state === "healthy" &&
              runtime.daemon.port === context.settings.daemonPort,
          },
          {
            id: "controller-port",
            host: controller.host,
            port: controller.port,
            owned:
              runtime?.core.running === true &&
              runtime.core.healthy === true &&
              runtime.endpoints.controller === controller.canonical,
          },
          {
            id: "mixed-port",
            host: "127.0.0.1",
            port: context.settings.mixedPort,
            owned:
              runtime?.core.running === true &&
              runtime.endpoints.mixedProxy === `127.0.0.1:${context.settings.mixedPort}`,
          },
        ];
        const results = await Promise.all(
          ports.map(async (port): Promise<DoctorCheck> => {
            if (port.owned)
              return {
                id: port.id,
                status: "ok",
                message: `${port.host}:${port.port} is in use by the observed Sash runtime`,
              };
            const observed = await (options.inspectPort ?? inspectListenerPort)(
              port.host,
              port.port,
            );
            return {
              id: port.id,
              status: observed.available ? "ok" : observed.unknown ? "warning" : "error",
              message: `${port.host}:${port.port}: ${observed.available ? "available" : (observed.reason ?? "in use")}`,
              ...(!observed.available
                ? {
                    advice:
                      "Inspect the owning application or choose a different port before starting/applying Sash",
                  }
                : {}),
            };
          }),
        );
        checks.push(...results);
      }
    }
  }
  if (!stateValid) add("runtime", "warning", "Runtime and port checks require a readable manifest");
  try {
    const connections = await (options.inspectProxyConnections ?? inspectWindowsProxyConnections)();
    if (connections.supported)
      add(
        "proxy-connections",
        connections.additionalRecords > 0 ? "warning" : "ok",
        connections.additionalRecords > 0
          ? `Windows has ${connections.additionalRecords} connection-specific proxy record(s) that Sash does not manage`
          : "No per-connection proxy entries in Windows",
        connections.additionalRecords > 0
          ? "Check per-connection proxy settings for Windows or VPN entries; Sash only manages the desktop LAN proxy and PAC settings"
          : undefined,
      );
  } catch {
    add(
      "proxy-connections",
      "warning",
      "Could not read the Windows per-connection proxy settings",
      "Check that Sash can read the current user's Windows Internet Settings; Sash does not manage per-connection records",
    );
  }
  return {
    schemaVersion: 1,
    healthy: !checks.some((check) => check.status === "error" || check.status === "warning"),
    complete: !checks.some((check) => check.status === "warning"),
    checks,
  };
}
