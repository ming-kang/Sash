import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadSettings } from "./app-state.js";
import type { DaemonPidRecord } from "./daemon/entry.js";
import { createDaemonClient } from "./daemon-client.js";
import { isPlainObject } from "./json-shape.js";
import { boundedLogTailSince, type LogFileCursor, logTailCursor } from "./log-follow.js";
import { type SashLayout, sashLayout } from "./paths.js";
import {
  buildSanitizedEnv,
  githubTokenEnv,
  isProcessAlive,
  killProcessGracefully,
  withPrivateAppendLogFds,
} from "./process.js";
import type { SashSettings } from "./settings.js";
import { readStateLockRecord, withStateLock } from "./state-lock.js";

export interface DaemonStoppedInfo {
  kind: "stopped";
  running: false;
  healthy: false;
  pid?: number;
}

export interface DaemonHealthyInfo {
  kind: "healthy";
  running: true;
  healthy: true;
  pid: number;
  port: number;
}

export interface DaemonUnhealthyInfo {
  kind: "unhealthy";
  running: true;
  healthy: false;
  pid?: number;
  port?: number;
}

export type DaemonRunningInfo = DaemonStoppedInfo | DaemonHealthyInfo | DaemonUnhealthyInfo;

export function readDaemonPidRecord(
  layout: SashLayout = sashLayout(),
): DaemonPidRecord | undefined {
  try {
    if (!fs.existsSync(layout.daemonPidFile)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(layout.daemonPidFile, "utf8")) as unknown;
    if (
      !isPlainObject(parsed) ||
      typeof parsed.pid !== "number" ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.token !== "string" ||
      !parsed.token.trim() ||
      typeof parsed.port !== "number" ||
      !Number.isInteger(parsed.port) ||
      parsed.port < 1 ||
      parsed.port > 65_535
    ) {
      return undefined;
    }
    return {
      pid: parsed.pid,
      token: parsed.token,
      port: parsed.port,
    };
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function evaluateDaemon(
  layout: SashLayout = sashLayout(),
  settings?: SashSettings,
): Promise<DaemonRunningInfo> {
  const record = readDaemonPidRecord(layout);
  const lease = readStateLockRecord(layout.daemonLeaseFile);
  const liveLease = lease && isProcessAlive(lease.pid);
  const liveRecord = record && isProcessAlive(record.pid);
  if (!liveLease && !liveRecord)
    return {
      kind: "stopped",
      running: false,
      healthy: false,
      ...(record || lease ? { pid: record?.pid ?? lease?.pid } : {}),
    };
  if (!lease || !record || !liveLease || !liveRecord || lease.pid !== record.pid) {
    return { kind: "unhealthy", running: true, healthy: false, pid: lease?.pid ?? record?.pid };
  }
  try {
    const client = createDaemonClient(record.port, (settings ?? loadSettings(layout)).daemonSecret);
    const health = await client.health();
    if (health.token === record.token && health.pid === record.pid) {
      return { kind: "healthy", running: true, healthy: true, pid: record.pid, port: record.port };
    }
  } catch {
    /* A live but unverified process must not be treated as stopped. */
  }
  return { kind: "unhealthy", running: true, healthy: false, pid: record.pid, port: record.port };
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

/** Bounded startup diagnostics: only errors appended after spawn are reported. */
function daemonStartupDiagnostics(layout: SashLayout, cursor: LogFileCursor): string {
  const details = boundedLogTailSince(layout.daemonErrLogFile, cursor, { maxLines: 20 });
  return `${details ? `\nRecent errors:\n${details}` : ""}\nCheck logs at: ${layout.daemonErrLogFile}`;
}

/**
 * Environment of the management daemon: fully scrubbed except for the GitHub
 * token, which only this process needs for release metadata and asset
 * downloads. The Core and every helper never receive it.
 */
export function daemonSpawnEnv(
  layout: SashLayout,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...buildSanitizedEnv(sourceEnv), ...githubTokenEnv(sourceEnv), SASH_HOME: layout.root };
}

export const DEFAULT_DAEMON_START_TIMEOUT_MS = 20_000;

async function spawnDaemonUnlocked(
  opts: { layout?: SashLayout; settings?: SashSettings; timeoutMs?: number } = {},
): Promise<{ pid: number }> {
  const layout = opts.layout ?? sashLayout();
  const settings = opts.settings ?? loadSettings(layout);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DAEMON_START_TIMEOUT_MS;

  const state = await evaluateDaemon(layout, settings);
  if (state.kind === "healthy") {
    return { pid: state.pid };
  }
  if (state.kind !== "stopped") {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(200);
      const current = await evaluateDaemon(layout, settings);
      if (current.kind === "healthy") return { pid: current.pid };
      if (current.kind === "stopped") break;
    }
    const owner = state.pid ? ` (PID=${state.pid})` : "";
    throw new Error(
      `sashd is already starting or unresponsive${owner}; refusing to start a competing daemon`,
    );
  }
  fs.mkdirSync(layout.logsDir, { recursive: true });
  fs.mkdirSync(layout.stateDir, { recursive: true });

  const entryPath = resolveDaemonEntryPath();

  // If entry ends in .ts, resolve tsx relative to Sash itself rather than the
  // data-directory cwd used by the child daemon. Compute every spawn argument
  // before opening log descriptors so a synchronous failure cannot leak them.
  const nodeArgs = entryPath.endsWith(".ts")
    ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, entryPath]
    : [entryPath];

  const errLogCursor = logTailCursor(layout.daemonErrLogFile);
  const child = withPrivateAppendLogFds(
    layout.daemonLogFile,
    layout.daemonErrLogFile,
    ({ stdoutFd, stderrFd }) =>
      spawn(process.execPath, nodeArgs, {
        cwd: layout.root,
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
        windowsHide: true,
        env: daemonSpawnEnv(layout),
      }),
  );

  let spawnError: Error | undefined;
  child.once("error", (err) => {
    spawnError = err;
  });

  child.unref();

  const pid = child.pid;
  if (!pid) {
    throw new Error("Failed to start sashd process (no PID returned)");
  }

  const client = createDaemonClient(settings.daemonPort, settings.daemonSecret);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(
        `Failed to start sashd: ${spawnError.message}${daemonStartupDiagnostics(layout, errLogCursor)}`,
      );
    }

    if (!isProcessAlive(pid)) {
      throw new Error(
        `sashd (PID=${pid}) exited unexpectedly during startup.${daemonStartupDiagnostics(layout, errLogCursor)}`,
      );
    }

    try {
      const record = readDaemonPidRecord(layout);
      if (record) {
        const health = await client.health();
        if (record.pid === pid && health.token === record.token && health.pid === pid) {
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
  const cleanup = terminated
    ? ""
    : " The daemon could not be confirmed stopped; ownership state was preserved.";
  throw new Error(
    `sashd started (PID=${pid}) but control API did not respond within ${timeoutMs}ms.${cleanup}${daemonStartupDiagnostics(layout, errLogCursor)}`,
  );
}

export async function spawnDaemon(
  opts: { layout?: SashLayout; settings?: SashSettings; timeoutMs?: number } = {},
): Promise<{ pid: number }> {
  const layout = opts.layout ?? sashLayout();
  const settings = opts.settings ?? loadSettings(layout);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DAEMON_START_TIMEOUT_MS;
  return withStateLock(
    layout.daemonStartLockFile,
    { purpose: "start sashd", timeoutMs: timeoutMs + 5000 },
    () => spawnDaemonUnlocked({ layout, settings, timeoutMs }),
  );
}

export async function ensureDaemon(
  opts: { layout?: SashLayout; settings?: SashSettings; timeoutMs?: number } = {},
): Promise<void> {
  const layout = opts.layout ?? sashLayout();
  const settings = opts.settings ?? loadSettings(layout);
  const state = await evaluateDaemon(layout, settings);
  if (state.kind === "healthy") return;
  await spawnDaemon({ layout, settings, timeoutMs: opts.timeoutMs });
}

export async function stopDaemonFromCli(
  opts: { layout?: SashLayout; settings?: SashSettings; timeoutMs?: number } = {},
): Promise<boolean> {
  const layout = opts.layout ?? sashLayout();
  const settings = opts.settings ?? loadSettings(layout);
  const state = await evaluateDaemon(layout, settings);
  if (state.kind === "stopped") return true;
  if (state.kind !== "healthy") return false;
  const client = createDaemonClient(state.port, settings.daemonSecret);
  await client.shutdown();
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  while (isProcessAlive(state.pid) && Date.now() < deadline) await sleep(100);
  return !isProcessAlive(state.pid);
}
