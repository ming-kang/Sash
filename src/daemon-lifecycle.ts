import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonPidRecord } from "./daemon.js";
import { SashDaemonClient } from "./daemon-client.js";
import { log } from "./log.js";
import { type SashLayout, sashLayout } from "./paths.js";
import {
  buildSanitizedEnv,
  clearPidRecord,
  commandLineContains,
  isProcessAlive,
  killProcessGracefully,
  tailFile,
} from "./process.js";
import { loadSettings, type SashSettings } from "./settings.js";

export interface DaemonRunningInfo {
  running: boolean;
  pid?: number;
  healthy?: boolean;
  stalePidFile?: boolean;
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
  if (!record) {
    return { running: false };
  }

  if (!isProcessAlive(record.pid)) {
    return { running: false, stalePidFile: true, pid: record.pid };
  }

  const s = settings ?? loadSettings(layout);
  const client = new SashDaemonClient(record.port || s.daemonPort, s.daemonSecret);

  try {
    const health = await client.health();
    if (health.ok && health.token === record.token) {
      return {
        running: true,
        pid: record.pid,
        healthy: true,
        port: record.port,
      };
    }
    return { running: false, stalePidFile: true, pid: record.pid };
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

export async function spawnDaemon(
  opts: { layout?: SashLayout; settings?: SashSettings; timeoutMs?: number } = {},
): Promise<{ pid: number }> {
  const layout = opts.layout ?? sashLayout();
  const settings = opts.settings ?? loadSettings(layout);
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const state = await evaluateDaemon(layout, settings);
  if (state.running && state.healthy && state.pid) {
    return { pid: state.pid };
  }
  if (state.stalePidFile) {
    clearPidRecord(layout.daemonPidFile);
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

  // If entry ends in .ts, we are in a tsx test environment
  const nodeArgs = entryPath.endsWith(".ts") ? ["--import", "tsx", entryPath] : [entryPath];

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
      clearPidRecord(layout.daemonPidFile);
      const details = tailFile(layout.daemonErrLogFile, 20);
      throw new Error(
        `Failed to start sashd: ${spawnError.message}${details ? `\n${details}` : ""}`,
      );
    }

    if (!isProcessAlive(pid)) {
      clearPidRecord(layout.daemonPidFile);
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
        if (health.ok && health.token === record.token) {
          return { pid };
        }
      }
    } catch {
      // not ready yet
    }

    await sleep(200);
  }

  // Timed out waiting for healthy daemon
  await killProcessGracefully(pid, { timeoutMs: 3000 });
  clearPidRecord(layout.daemonPidFile);
  const details = tailFile(layout.daemonErrLogFile, 20);
  throw new Error(
    `sashd started (PID=${pid}) but control API did not respond within ${timeoutMs}ms.${
      details ? `\nRecent errors:\n${details}` : ""
    }\nCheck logs at: ${layout.daemonErrLogFile}`,
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
  if (!record) return true;

  const pid = record.pid;
  if (!isProcessAlive(pid)) {
    clearPidRecord(layout.daemonPidFile);
    return true;
  }

  // Try graceful shutdown via API first
  const client = new SashDaemonClient(record.port || settings.daemonPort, settings.daemonSecret);
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

  if (!isProcessAlive(pid)) {
    clearPidRecord(layout.daemonPidFile);
    return true;
  }

  // Still alive: verify command line before sending kill signal (safety invariant)
  const isOurs = commandLineContains(pid, "daemon-entry");
  if (!isOurs) {
    log.warn(
      `Refusing to terminate PID ${pid}: process command line does not match sashd. Verify manually.`,
    );
    return false;
  }

  const killed = await killProcessGracefully(pid, { timeoutMs: 4000 });
  if (killed) {
    clearPidRecord(layout.daemonPidFile);
    return true;
  }

  log.error(`sashd process is still running after termination attempt (PID=${pid}).`);
  return false;
}
