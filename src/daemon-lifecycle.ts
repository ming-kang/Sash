import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DaemonPidRecord } from "./daemon.js";
import { SashDaemonClient } from "./daemon-client.js";
import { log } from "./log.js";
import { type SashLayout, sashLayout } from "./paths.js";
import {
  buildSanitizedEnv,
  commandLineContains,
  isProcessAlive,
  killProcessGracefully,
  tailFile,
} from "./process.js";
import { loadSettings, type SashSettings } from "./settings.js";
import { readStateLockRecord, type StateLockRecord, withStateLock } from "./state-lock.js";

export interface DaemonRunningInfo {
  running: boolean;
  pid?: number;
  healthy?: boolean;
  stalePidFile?: boolean;
  staleLeaseFile?: boolean;
  legacyOwnership?: boolean;
  port?: number;
}

export function readDaemonPidRecord(
  layout: SashLayout = sashLayout(),
): DaemonPidRecord | undefined {
  try {
    if (!fs.existsSync(layout.daemonPidFile)) return undefined;
    const raw = fs.readFileSync(layout.daemonPidFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<DaemonPidRecord>;
    if (
      typeof parsed.pid === "number" &&
      parsed.pid > 0 &&
      typeof parsed.token === "string" &&
      typeof parsed.port === "number"
    ) {
      return parsed as DaemonPidRecord;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Inspect whether sashd is currently running and answers with the matching
 * boot token.
 */
export async function evaluateDaemon(
  layout: SashLayout = sashLayout(),
  settings?: SashSettings,
): Promise<DaemonRunningInfo> {
  const record = readDaemonPidRecord(layout);
  let lease: StateLockRecord | undefined;
  try {
    lease = readStateLockRecord(layout.daemonLeaseFile);
  } catch {
    // A corrupt singleton record is an ownership conflict, not evidence that
    // it is safe to mutate state or start a second daemon.
    return { running: true, healthy: false, ...(record ? { stalePidFile: true } : {}) };
  }

  if (!lease || !isProcessAlive(lease.pid)) {
    if (record && isProcessAlive(record.pid)) {
      const s = settings ?? loadSettings(layout);
      const legacyClient = new SashDaemonClient(record.port || s.daemonPort, s.daemonSecret);
      try {
        const health = await legacyClient.health();
        if (health.ok && health.token === record.token && health.pid === record.pid) {
          return {
            running: true,
            healthy: true,
            legacyOwnership: true,
            pid: record.pid,
            port: record.port,
          };
        }
      } catch {
        // Fall through to the fail-closed ownership result below.
      }
      return {
        running: true,
        healthy: false,
        legacyOwnership: true,
        pid: record.pid,
        ...(lease ? { staleLeaseFile: true } : {}),
      };
    }
    return {
      running: false,
      ...(record || lease ? { pid: record?.pid ?? lease?.pid } : {}),
      ...(record ? { stalePidFile: true } : {}),
      ...(lease ? { staleLeaseFile: true } : {}),
    };
  }
  if (!record || record.pid !== lease.pid || !isProcessAlive(record.pid)) {
    return {
      running: true,
      healthy: false,
      pid: lease.pid,
      ...(record ? { stalePidFile: true } : {}),
    };
  }

  const s = settings ?? loadSettings(layout);
  const client = new SashDaemonClient(record.port || s.daemonPort, s.daemonSecret);

  try {
    const health = await client.health();
    if (health.ok && health.token === record.token && health.pid === record.pid) {
      return {
        running: true,
        pid: record.pid,
        healthy: true,
        port: record.port,
      };
    }
    return { running: true, healthy: false, stalePidFile: true, pid: record.pid };
  } catch {
    // Process is alive but API doesn't answer (may still be booting or stuck)
    return {
      running: true,
      pid: record.pid,
      healthy: false,
      port: record.port,
    };
  }
}

function resolveDaemonEntryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.join(here, "daemon-entry.js");
  if (fs.existsSync(candidate)) return candidate;
  // During tests / tsx execution, fallback to daemon-entry.ts
  const tsCandidate = path.join(here, "daemon-entry.ts");
  if (fs.existsSync(tsCandidate)) return tsCandidate;
  return candidate;
}

async function spawnDaemonUnlocked(
  opts: { layout?: SashLayout; settings?: SashSettings; timeoutMs?: number } = {},
): Promise<{ pid: number }> {
  const layout = opts.layout ?? sashLayout();
  const settings = opts.settings ?? loadSettings(layout);
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const state = await evaluateDaemon(layout, settings);
  if (state.running && state.healthy && state.pid) {
    return { pid: state.pid };
  }
  if (state.running) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(200);
      const current = await evaluateDaemon(layout, settings);
      if (current.running && current.healthy && current.pid) return { pid: current.pid };
      if (!current.running) break;
    }
    const owner = state.pid ? ` (PID=${state.pid})` : "";
    throw new Error(
      `sashd is already starting or unresponsive${owner}; refusing to start a competing daemon`,
    );
  }
  fs.mkdirSync(layout.logsDir, { recursive: true });
  fs.mkdirSync(layout.stateDir, { recursive: true });

  const outFd = fs.openSync(layout.daemonLogFile, "a", 0o600);
  let errFd: number;
  try {
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(layout.daemonLogFile, 0o600);
      } catch {
        // ignore
      }
    }
    errFd = fs.openSync(layout.daemonErrLogFile, "a", 0o600);
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(layout.daemonErrLogFile, 0o600);
      } catch {
        // ignore
      }
    }
  } catch (err) {
    fs.closeSync(outFd);
    throw err;
  }

  const entryPath = resolveDaemonEntryPath();
  const sanitizedEnv = buildSanitizedEnv();

  // If entry ends in .ts, resolve tsx relative to Sash itself rather than the
  // data-directory cwd used by the child daemon.
  const nodeArgs = entryPath.endsWith(".ts")
    ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, entryPath]
    : [entryPath];

  const child = spawn(process.execPath, nodeArgs, {
    cwd: layout.root,
    detached: true,
    stdio: ["ignore", outFd, errFd],
    windowsHide: true,
    env: { ...sanitizedEnv, SASH_HOME: layout.root },
  });

  let spawnError: Error | undefined;
  child.once("error", (err) => {
    spawnError = err;
  });

  child.unref();
  try {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  } catch {
    // ignore
  }

  const pid = child.pid;
  if (!pid) {
    throw new Error("Failed to start sashd process (no PID returned)");
  }

  const client = new SashDaemonClient(settings.daemonPort, settings.daemonSecret);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (spawnError) {
      const details = tailFile(layout.daemonErrLogFile, 20);
      throw new Error(
        `Failed to start sashd: ${spawnError.message}${details ? `\n${details}` : ""}`,
      );
    }

    if (!isProcessAlive(pid)) {
      const details = tailFile(layout.daemonErrLogFile, 20);
      throw new Error(
        `sashd (PID=${pid}) exited unexpectedly during startup.${
          details ? `\nRecent errors:\n${details}` : ""
        }\nCheck logs at: ${layout.daemonErrLogFile}`,
      );
    }

    try {
      const record = readDaemonPidRecord(layout);
      if (record) {
        const health = await client.health();
        if (
          record.pid === pid &&
          health.ok &&
          health.token === record.token &&
          health.pid === pid
        ) {
          return { pid };
        }
      }
    } catch {
      // not ready yet
    }

    await sleep(200);
  }

  // Timed out waiting for healthy daemon. Preserve ownership records unless
  // termination is positively confirmed by the owned child handle.
  const terminated = await killProcessGracefully(pid, {
    timeoutMs: 3000,
    verify: () =>
      child.pid === pid &&
      (child.exitCode === null || child.exitCode === undefined) &&
      (child.signalCode === null || child.signalCode === undefined)
        ? "match"
        : "mismatch",
  });
  const details = tailFile(layout.daemonErrLogFile, 20);
  const cleanup = terminated
    ? ""
    : " The daemon could not be confirmed stopped; ownership state was preserved.";
  throw new Error(
    `sashd started (PID=${pid}) but control API did not respond within ${timeoutMs}ms.${cleanup}${
      details ? `\nRecent errors:\n${details}` : ""
    }\nCheck logs at: ${layout.daemonErrLogFile}`,
  );
}

export async function spawnDaemon(
  opts: { layout?: SashLayout; settings?: SashSettings; timeoutMs?: number } = {},
): Promise<{ pid: number }> {
  const layout = opts.layout ?? sashLayout();
  const settings = opts.settings ?? loadSettings(layout);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return withStateLock(
    layout.daemonStartLockFile,
    { purpose: "start sashd", timeoutMs: timeoutMs + 5000 },
    () => spawnDaemonUnlocked({ layout, settings, timeoutMs }),
  );
}

export async function ensureDaemon(
  opts: { layout?: SashLayout; settings?: SashSettings } = {},
): Promise<void> {
  const layout = opts.layout ?? sashLayout();
  const settings = opts.settings ?? loadSettings(layout);
  const state = await evaluateDaemon(layout, settings);
  if (state.running && state.healthy) return;
  await spawnDaemon({ layout, settings });
}

export async function stopDaemonFromCli(
  opts: { layout?: SashLayout; settings?: SashSettings; timeoutMs?: number } = {},
): Promise<boolean> {
  const layout = opts.layout ?? sashLayout();
  const settings = opts.settings ?? loadSettings(layout);
  const record = readDaemonPidRecord(layout);
  if (!record) {
    try {
      const lease = readStateLockRecord(layout.daemonLeaseFile);
      if (!lease || !isProcessAlive(lease.pid)) return true;
      log.warn(`sashd is still starting or unresponsive (PID=${lease.pid}); try stopping again.`);
      return false;
    } catch {
      log.warn("Refusing to stop sashd: singleton ownership record is corrupt.");
      return false;
    }
  }

  const pid = record.pid;
  if (!isProcessAlive(pid)) return true;

  let lease: StateLockRecord | undefined;
  try {
    lease = readStateLockRecord(layout.daemonLeaseFile);
  } catch {
    log.warn("Refusing to stop sashd: singleton ownership record is corrupt.");
    return false;
  }
  if (lease && (!isProcessAlive(lease.pid) || lease.pid !== pid)) {
    log.warn(
      `Refusing to stop PID ${pid}: daemon PID metadata does not match singleton ownership.`,
    );
    return false;
  }

  const client = new SashDaemonClient(record.port || settings.daemonPort, settings.daemonSecret);
  const legacyOwnership = !lease;
  const healthMatchesRecord = async (): Promise<boolean> => {
    try {
      const health = await client.health();
      return health.ok && health.token === record.token && health.pid === pid;
    } catch {
      return false;
    }
  };
  if (!(await healthMatchesRecord())) {
    log.warn(`Refusing to stop unverified sashd PID ${pid}.`);
    return false;
  }

  // Try graceful shutdown via API first.
  try {
    await client.shutdown();
  } catch {
    // API may be unreachable
  }

  // Poll for process termination
  const deadline = Date.now() + (opts.timeoutMs ?? 6000);
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await sleep(200);
  }

  if (!isProcessAlive(pid)) return true;
  if (legacyOwnership) {
    log.warn(
      `Legacy sashd PID ${pid} did not stop gracefully; refusing force termination without a singleton lease.`,
    );
    return false;
  }

  return withStateLock(
    layout.mutationLockFile,
    { purpose: "verify forced sashd stop", timeoutMs: 10_000 },
    async () => {
      if (!isProcessAlive(pid)) return true;

      // A forced daemon exit can orphan its Core and leave an OS proxy pointing
      // at a dead port. Hold the mutation lock and require a fresh observation
      // proving all managed runtime state has already been released.
      try {
        const status = await client.status(true);
        const actual = status.systemProxy.actual;
        if (
          status.daemon.pid !== pid ||
          status.core.running ||
          status.systemProxy.applied ||
          !actual ||
          actual.enabled ||
          (actual.supported && Boolean(actual.details)) ||
          fs.existsSync(layout.systemProxyStateFile) ||
          fs.existsSync(`${layout.systemProxyStateFile}.lock`)
        ) {
          log.warn(
            `Refusing to force-terminate sashd PID ${pid}: managed runtime cleanup is incomplete or unknown.`,
          );
          return false;
        }
      } catch {
        log.warn(
          `Refusing to force-terminate unresponsive sashd PID ${pid}: runtime cleanup cannot be verified.`,
        );
        return false;
      }

      const verifyDaemonIdentity = async () => {
        if (!(await healthMatchesRecord())) return "mismatch" as const;
        return commandLineContains(pid, "daemon-entry") ? ("match" as const) : ("unknown" as const);
      };
      if ((await verifyDaemonIdentity()) !== "match") {
        log.warn(
          `Refusing to terminate PID ${pid}: process identity no longer matches sashd. Verify manually.`,
        );
        return false;
      }

      const killed = await killProcessGracefully(pid, {
        timeoutMs: 4000,
        verify: verifyDaemonIdentity,
      });
      if (killed) return true;

      log.error(`sashd process is still running after termination attempt (PID=${pid}).`);
      return false;
    },
  );
}
