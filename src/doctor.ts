import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { MAX_STATE_BYTES, parseState, readState, type SashState } from "./app-state.js";
import { CORE_BINARY_SIZE_LIMIT } from "./core-binary.js";
import { readInstallRecord } from "./core-install-record.js";
import { errorMessage } from "./error-utils.js";
import { pathEntryExists } from "./fs-atomic.js";
import { inspectInstallation } from "./installation.js";
import { currentPackageRoot, readSashPackageInfo, supportsNode } from "./package-info.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { DEFAULT_SETTINGS, parseControllerAddress } from "./settings.js";
import {
  type CliRuntimeStatus,
  collectRuntimeStatus,
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

/** Read-only: a valid state backup only upgrades recovery advice, never the state itself. */
function restorableStateBackup(layout: SashLayout): boolean {
  try {
    const stat = fs.lstatSync(layout.settingsBackupFile);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return false;
    parseState(JSON.parse(fs.readFileSync(layout.settingsBackupFile, "utf8")) as unknown);
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
  try {
    const info = readSashPackageInfo(packageRoot);
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
      state ? `Validated ${layout.settingsFile}` : `No application state at ${layout.settingsFile}`,
      state ? undefined : "Run sash web or sash start to initialize this data directory",
    );
  } catch (error) {
    stateValid = false;
    add(
      "manifest",
      "error",
      `${layout.settingsFile}: ${errorMessage(error)}`,
      restorableStateBackup(layout)
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
        `Core binary/install metadata is inconsistent: ${layout.coreExe}`,
        "Preserve existing files, stop the instance and inspect its install record before reinstalling",
      );
    else add("core", "ok", `Core ${record.coreVersion}; executable and install record are present`);
  } catch (error) {
    add(
      "core",
      "error",
      errorMessage(error),
      "Inspect the executable and install record before reinstalling Core",
    );
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
        `Management ${runtime.daemon.state}; Core ${runtime.core.running === null ? "unknown" : runtime.core.running ? "running" : "stopped"}`,
        runtime.daemon.state === "unhealthy"
          ? "Inspect sash logs --daemon --errors; do not stop an unverified process"
          : undefined,
      );
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
        `Desired ${proxy.desired ? "on" : "off"}; Sash ${proxy.daemonApplied === null ? "unknown" : proxy.daemonApplied ? "applied" : "not applied"}; OS ${proxy.osObserved.enabled === null ? "unknown" : proxy.osObserved.enabled ? "on" : "off"}`,
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
        `Login startup ${auto.state}${auto.reason ? `: ${auto.reason}` : ""}`,
        auto.state === "stale" || auto.state === "disabled"
          ? "Inspect sash auto status; use sash auto on for the intended data directory to repair startup"
          : undefined,
      );
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
        const results = await Promise.allSettled(
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
        for (const [index, result] of results.entries()) {
          if (result.status === "fulfilled") checks.push(result.value);
          else add(ports[index]?.id ?? "port", "warning", errorMessage(result.reason));
        }
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
          ? `${connections.additionalRecords} additional Windows connection record(s) found; their proxy settings are outside Sash management`
          : "No additional Windows per-connection proxy records detected",
        connections.additionalRecords > 0
          ? "Inspect Windows/VPN connection proxy settings. Sash manages the desktop LAN proxy/PAC settings and does not change per-connection records"
          : undefined,
      );
  } catch {
    add(
      "proxy-connections",
      "warning",
      "Windows per-connection proxy settings could not be inspected",
      "Check access to the current user's Internet Settings\\Connections registry key; Sash does not manage per-connection records",
    );
  }
  return {
    schemaVersion: 1,
    healthy: !checks.some((check) => check.status === "error" || check.status === "warning"),
    complete: !checks.some((check) => check.status === "warning"),
    checks,
  };
}
