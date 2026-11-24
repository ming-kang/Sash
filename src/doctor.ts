import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { readState, type SashState } from "./app-state.js";
import { readLoginStartRecord } from "./autostart/login-record.js";
import { CORE_BINARY_SIZE_LIMIT, readInstallRecord } from "./core.js";
import { GEODATA_FILE_NAMES } from "./core-config-validation.js";
import { resolveDaemonSession } from "./daemon-session.js";
import { errorMessage } from "./error-utils.js";
import { pathEntryExists } from "./fs-atomic.js";
import { type DownloadTransport, fetchWithRetry } from "./http.js";
import { currentPackageRoot, readSashPackageInfo, supportsNode } from "./package-info.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { inspectInstallation } from "./sash-installation.js";
import { DEFAULT_SETTINGS, parseControllerAddress } from "./settings.js";
import {
  autostartPresentation,
  type CliRuntimeStatus,
  collectRuntimeStatus,
  describeDownloadTransport,
  type StatusObservationContext,
  type StatusObservationDependencies,
  systemProxyPresentation,
} from "./status.js";
import {
  inspectWindowsProxyConnections,
  type ProxyConnectionsObservation,
} from "./sysproxy/windows-connections.js";
import { describeTunHelper } from "./tun-service.js";

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

const NETWORK_PROBE_TIMEOUT_MS = 15_000;

async function probeHttpReachability(url: string, proxyUri?: string): Promise<boolean> {
  try {
    const res = await fetchWithRetry(url, {
      attempts: 1,
      deadlineMs: NETWORK_PROBE_TIMEOUT_MS,
      ...(proxyUri !== undefined ? { proxyUri } : {}),
    });
    await res.discard();
    return true;
  } catch {
    return false;
  }
}

function describeProbeTransport(transport: DownloadTransport | undefined): string {
  return transport ? describeDownloadTransport(transport) : "a direct connection";
}

export interface DiagnoseOptions {
  layout?: SashLayout;
  packageRoot?: string;
  status?: StatusObservationDependencies;
  inspectPort?: typeof inspectListenerPort;
  inspectProxyConnections?: () => Promise<ProxyConnectionsObservation>;
  probeReachability?: (url: string, transport: DownloadTransport | undefined) => Promise<boolean>;
}

function check(
  id: string,
  status: DoctorCheck["status"],
  message: string,
  advice?: string,
): DoctorCheck {
  return { id, status, message, ...(advice ? { advice } : {}) };
}

function installationChecks(
  installation: ReturnType<typeof inspectInstallation>,
  packageRoot: string,
): { checks: DoctorCheck[]; installedVersion?: string } {
  const checks: DoctorCheck[] = [
    check(
      "installation",
      installation.kind === "unknown"
        ? "warning"
        : installation.kind === "npm-global"
          ? "ok"
          : "info",
      installation.kind === "npm-global"
        ? `Global npm installation: ${installation.prefix}`
        : installation.reason,
    ),
  ];
  let installedVersion: string | undefined;
  try {
    const info = readSashPackageInfo(packageRoot);
    installedVersion = info.version;
    checks.push(
      check(
        "node",
        supportsNode(info) ? "ok" : "error",
        `Node ${process.version}; Sash ${info.version} requires ${info.nodeRange}`,
        supportsNode(info) ? undefined : "Use a Node executable supported by this Sash release",
      ),
    );
  } catch (error) {
    checks.push(
      check(
        "node",
        "error",
        errorMessage(error),
        "Repair the Sash package through its installation method",
      ),
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
    checks.push(check("dashboard", "ok", "Bundled dashboard and command entries are present"));
  } catch (error) {
    checks.push(
      check(
        "dashboard",
        "error",
        errorMessage(error),
        installation.kind === "source"
          ? "Run npm run build in the source checkout"
          : "Stop affected instances and reinstall the Sash package",
      ),
    );
  }
  return { checks, installedVersion };
}

function manifestChecks(layout: SashLayout): {
  checks: DoctorCheck[];
  state: SashState | undefined;
  stateValid: boolean;
} {
  try {
    const state = readState(layout);
    return {
      checks: [
        check(
          "manifest",
          state ? "ok" : "info",
          state
            ? `Settings are readable: ${layout.settingsFile}`
            : `No settings yet in this folder: ${layout.settingsFile}`,
          state ? undefined : "Run sash start or sash web to create them",
        ),
      ],
      state,
      stateValid: true,
    };
  } catch (error) {
    return {
      checks: [
        check(
          "manifest",
          "error",
          `${layout.settingsFile}: ${errorMessage(error)}`,
          pathEntryExists(layout.settingsBackupFile)
            ? `Stop Sash, then copy ${layout.settingsBackupFile} over ${layout.settingsFile} to restore the most recently committed settings and profile index`
            : "Preserve the file and restore a valid schema-2 manifest before starting Sash",
        ),
      ],
      state: undefined,
      stateValid: false,
    };
  }
}

function coreInstallCheck(layout: SashLayout): DoctorCheck {
  try {
    const binary = pathEntryExists(layout.coreExe);
    const metadata = pathEntryExists(layout.installFile);
    const record = readInstallRecord(layout);
    const binaryStat = binary ? fs.lstatSync(layout.coreExe) : undefined;
    if (!binary && !metadata)
      return check("core", "info", "Core is not installed", "Run sash start to install Core");
    if (
      !binaryStat?.isFile() ||
      binaryStat.size === 0 ||
      binaryStat.size > CORE_BINARY_SIZE_LIMIT ||
      !record
    )
      return check(
        "core",
        "error",
        `The Core binary and its install record disagree: ${layout.coreExe}`,
        "Preserve existing files, stop the instance and inspect its install record before reinstalling",
      );
    return check("core", "ok", `Core ${record.coreVersion} is installed`);
  } catch (error) {
    return check(
      "core",
      "error",
      errorMessage(error),
      "Inspect the executable and install record before reinstalling Core",
    );
  }
}

function geodataCheck(layout: SashLayout): DoctorCheck {
  try {
    const present = GEODATA_FILE_NAMES.filter((name) =>
      pathEntryExists(path.join(layout.root, name)),
    );
    if (present.length === 0) {
      return check(
        "geodata",
        "info",
        "geodata is not downloaded yet",
        "The Core downloads its databases on first start; on an offline machine place them in the data folder beforehand",
      );
    }
    return check("geodata", "ok", `geodata present: ${present.join(", ")}`);
  } catch (error) {
    return check("geodata", "info", errorMessage(error));
  }
}

async function tunChecks(context: StatusObservationContext): Promise<DoctorCheck[]> {
  try {
    const owner = await resolveDaemonSession(context);
    const tun = owner.kind === "daemon" ? await owner.client.tunStatus() : null;
    const state = tun?.supported ? tun.privilege.state : undefined;
    const checks = [
      check(
        "tun-helper",
        state === "stale" ||
          state === "unknown" ||
          (state === "missing" && context.settings.tun.enable)
          ? "warning"
          : state === "ready"
            ? "ok"
            : "info",
        tun
          ? `TUN helper: ${describeTunHelper(tun)}`
          : "TUN helper status unavailable while Sash is stopped",
        state && state !== "ready" ? "Run sash tun helper install" : undefined,
      ),
    ];
    if (tun?.applied)
      checks.push(
        check("tun-network", "info", "TUN is applied; OS routes and DNS are not checked"),
      );
    return checks;
  } catch {
    return [check("tun-helper", "info", "Could not read TUN helper status")];
  }
}

function autostartChecks(runtime: CliRuntimeStatus, layout: SashLayout): DoctorCheck[] {
  const auto = runtime.autostart;
  const line = autostartPresentation(auto);
  const advice = [
    line.advice,
    auto.state === "stale" || auto.state === "disabled"
      ? "Run sash auto on to repair the entry, or sash auto off to remove it"
      : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
  const checks = [
    check(
      "autostart",
      auto.state === "unknown"
        ? "warning"
        : auto.state === "stale" || auto.state === "disabled"
          ? "error"
          : auto.state === "unsupported"
            ? "info"
            : "ok",
      line.message,
      advice || undefined,
    ),
  ];
  if (auto.state === "on" || auto.state === "stale" || auto.state === "disabled") {
    const login = readLoginStartRecord(layout);
    if (!login) {
      checks.push(check("login-start", "info", "no login start recorded yet"));
    } else if (login.ok) {
      checks.push(check("login-start", "ok", `last login start succeeded at ${login.at}`));
    } else {
      checks.push(
        check(
          "login-start",
          "error",
          `last login start failed: ${login.error ?? "unknown error"}`,
          "Run sash logs for details, then sash start to verify the recovery",
        ),
      );
    }
  }
  return checks;
}

async function runtimeChecks(
  context: StatusObservationContext,
  options: DiagnoseOptions,
  installedVersion: string | undefined,
  state: SashState | undefined,
): Promise<{ checks: DoctorCheck[]; runtime?: CliRuntimeStatus }> {
  try {
    const runtime = await collectRuntimeStatus(context, options.status);
    const checks: DoctorCheck[] = [
      check(
        "runtime",
        runtime.daemon.state === "unhealthy" ||
          (runtime.core.running === true && runtime.core.healthy !== true)
          ? "warning"
          : "ok",
        `Sash ${runtime.daemon.state === "healthy" ? "is running" : runtime.daemon.state === "stopped" ? "is not running" : "is not responding"} · Core ${runtime.core.running === null ? "unknown" : runtime.core.running ? "running" : "stopped"}`,
        runtime.daemon.state === "unhealthy"
          ? "Inspect sash logs --daemon --errors; do not stop an unverified process"
          : undefined,
      ),
    ];
    const runningVersion = runtime.daemon.version;
    if (runningVersion && installedVersion) {
      checks.push(
        check(
          "sash-version",
          runningVersion === installedVersion ? "ok" : "warning",
          runningVersion === installedVersion
            ? `Sash ${runningVersion} is installed and running`
            : `Sash ${installedVersion} is installed; the running Sash is still ${runningVersion}`,
          runningVersion === installedVersion
            ? undefined
            : "Run sash stop && sash start to load the installed version",
        ),
      );
    }
    if (!state && runtime.daemon.running)
      checks.push(
        check(
          "runtime-manifest",
          "error",
          "A running Sash has no readable saved manifest",
          "Restore the missing state and credentials from a backup before modifying Sash settings",
        ),
      );
    const proxy = runtime.systemProxy;
    const proxyLine = systemProxyPresentation(proxy.desired, proxy.osObserved);
    const proxyAdvice = [runtime.queryError, proxyLine.advice]
      .filter((part): part is string => Boolean(part))
      .join("\n");
    checks.push(
      check(
        "proxy",
        proxy.osObserved.enabled === null || proxy.daemonApplied === null ? "warning" : "ok",
        proxyLine.message,
        proxyAdvice || undefined,
      ),
    );
    if (context.settings.tun.enable || runtime.daemon.state === "healthy") {
      checks.push(...(await tunChecks(context)));
    }
    checks.push(...autostartChecks(runtime, context.layout));
    return { checks, runtime };
  } catch (error) {
    return {
      checks: [
        check(
          "runtime",
          "warning",
          errorMessage(error),
          "Inspect sash status and sash logs --daemon",
        ),
      ],
    };
  }
}

async function networkCheck(
  transport: DownloadTransport | undefined,
  probeReachability: DiagnoseOptions["probeReachability"],
): Promise<DoctorCheck> {
  const via = `via ${describeProbeTransport(transport)}`;
  const probe = probeReachability ?? ((url: string) => probeHttpReachability(url, transport?.uri));
  const results = await Promise.all(
    NETWORK_PROBES.map(async ({ name, url }) => ({
      name,
      reachable: await probe(url, transport),
    })),
  );
  const reachable = results.filter((result) => result.reachable).map((result) => result.name);
  const unreachable = results.filter((result) => !result.reachable).map((result) => result.name);
  const releaseApiReachable = results.find((result) => result.name === "api.github.com")?.reachable;
  if (reachable.length === results.length) {
    return check(
      "network",
      "ok",
      `Core download sources are reachable ${via}: ${reachable.join(", ")}`,
    );
  }
  if (reachable.length === 0) {
    return check(
      "network",
      "warning",
      `No Core download source is reachable ${via}`,
      transport?.source === "core"
        ? "Check the proxy group the Core is using, or set HTTP_PROXY to a running proxy; a manual offline install is described in docs/usage.md"
        : transport?.source === "environment"
          ? `Check whether ${transport.uri} is running, or unset HTTP_PROXY; a manual offline install is described in docs/usage.md`
          : "Check your network or set HTTP_PROXY to a running proxy; a manual offline install is described in docs/usage.md",
    );
  }
  if (releaseApiReachable !== true) {
    return check(
      "network",
      "warning",
      `The GitHub release API is unreachable ${via}; Core downloads cannot be verified`,
      "Set HTTP_PROXY to a running proxy, or retry when api.github.com is reachable",
    );
  }
  return check(
    "network",
    "ok",
    `Some Core download mirrors are unreachable ${via}: ${unreachable.join(", ")}`,
  );
}

async function portChecks(
  context: StatusObservationContext,
  runtime: CliRuntimeStatus | undefined,
  inspectPort: typeof inspectListenerPort,
): Promise<DoctorCheck[]> {
  const controller = parseControllerAddress(context.settings.controller);
  if (!controller) return [];
  const ports = [
    {
      id: "daemon-port",
      host: "127.0.0.1",
      port: context.settings.daemonPort,
      owned:
        runtime?.daemon.state === "healthy" && runtime.daemon.port === context.settings.daemonPort,
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
  return Promise.all(
    ports.map(async (port): Promise<DoctorCheck> => {
      if (port.owned)
        return check(
          port.id,
          "ok",
          `${port.host}:${port.port} is in use by the observed Sash runtime`,
        );
      const observed = await inspectPort(port.host, port.port);
      return check(
        port.id,
        observed.available ? "ok" : observed.unknown ? "warning" : "error",
        `${port.host}:${port.port}: ${observed.available ? "available" : (observed.reason ?? "in use")}`,
        !observed.available
          ? "Inspect the owning application or choose a different port before starting Sash or applying configuration"
          : undefined,
      );
    }),
  );
}

async function proxyConnectionsCheck(
  inspect: () => Promise<ProxyConnectionsObservation>,
): Promise<DoctorCheck | null> {
  try {
    const connections = await inspect();
    if (!connections.supported) return null;
    return check(
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
    return check(
      "proxy-connections",
      "warning",
      "Could not read the Windows per-connection proxy settings",
      "Check that Sash can read the current user's Windows Internet Settings; Sash does not manage per-connection records",
    );
  }
}

export async function diagnoseSash(options: DiagnoseOptions = {}): Promise<DoctorReport> {
  const layout = options.layout ?? sashLayout();
  const packageRoot = options.packageRoot ?? currentPackageRoot();
  const installation = inspectInstallation({ packageRoot });

  const { checks, installedVersion } = installationChecks(installation, packageRoot);
  const manifest = manifestChecks(layout);
  checks.push(...manifest.checks, coreInstallCheck(layout), geodataCheck(layout));

  if (manifest.stateValid) {
    const context: StatusObservationContext = {
      layout,
      settings: manifest.state?.settings ?? { ...DEFAULT_SETTINGS },
    };
    const { checks: observed, runtime } = await runtimeChecks(
      context,
      options,
      installedVersion,
      manifest.state,
    );
    checks.push(...observed);
    const transport = runtime?.downloadTransport;
    const [network, connections] = await Promise.all([
      networkCheck(transport, options.probeReachability),
      proxyConnectionsCheck(options.inspectProxyConnections ?? inspectWindowsProxyConnections),
    ]);
    checks.push(network);
    if (manifest.state || !runtime?.daemon.running) {
      checks.push(
        ...(await portChecks(context, runtime, options.inspectPort ?? inspectListenerPort)),
      );
    }
    if (connections) checks.push(connections);
  } else {
    checks.push(check("runtime", "warning", "Runtime and port checks require a readable manifest"));
    const connections = await proxyConnectionsCheck(
      options.inspectProxyConnections ?? inspectWindowsProxyConnections,
    );
    if (connections) checks.push(connections);
  }

  return {
    schemaVersion: 1,
    healthy: !checks.some((entry) => entry.status === "error" || entry.status === "warning"),
    complete: !checks.some((entry) => entry.status === "warning"),
    checks,
  };
}
