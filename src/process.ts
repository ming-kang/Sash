import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MihomoApi } from "./api.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { log } from "./log.js";
import { type SashLayout, sashLayout } from "./paths.js";
import { loadSettings, type SashSettings } from "./settings.js";

export interface PidRecord {
  pid: number;
  exe: string;
  startedAt: string;
}

export interface RunningInfo {
  /** True when PID is alive and identity probe verified (or safely unknown). */
  running: boolean;
  pid?: number;
  /** True when external-controller API /version responds with 2xx. */
  healthy?: boolean;
  /** Core version string returned by external-controller API /version. */
  version?: string;
  /** True when a PID file was found on disk but the process is dead or mismatched. */
  stalePidFile?: boolean;
}

export interface StartOptions {
  layout?: SashLayout;
  settings?: SashSettings;
  timeoutMs?: number;
}

export type ProcessIdentity = "match" | "mismatch" | "unknown";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if a process with this PID exists (including when signal is not permitted). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

function normalizePath(filePath: string): string {
  const cleaned = filePath.replace(/\s+\(deleted\)$/i, "").trim();
  try {
    return fs.realpathSync.native(cleaned);
  } catch {
    return path.resolve(cleaned);
  }
}

function exePathsMatch(observedPath: string, expectedPath: string): boolean {
  try {
    const a = normalizePath(observedPath);
    const b = normalizePath(expectedPath);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

function basenameLower(filePath: string): string {
  return path.posix.basename(filePath.replace(/\\/g, "/")).toLowerCase();
}

function stripExeSuffix(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, "");
}

function imageMatchesExpectedExe(imageOrComm: string, expectedExe: string): boolean {
  const expected = stripExeSuffix(basenameLower(expectedExe));
  if (!expected) return false;
  const observed = stripExeSuffix(basenameLower(imageOrComm.trim()));
  if (!observed) return false;
  if (observed === expected) return true;
  // Linux /proc/pid/comm is truncated to 15 characters
  if (observed.length === 15 && expected.startsWith(observed) && expected.length > 15) {
    return true;
  }
  return false;
}

let cachedPowerShell: string | undefined;

function runPowerShell(script: string, timeoutMs = 5000): string | undefined {
  const shells = cachedPowerShell
    ? [cachedPowerShell, ...["powershell.exe", "pwsh.exe"].filter((s) => s !== cachedPowerShell)]
    : ["powershell.exe", "pwsh.exe"];
  for (const shell of shells) {
    try {
      const output = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
      }).trim();
      cachedPowerShell = shell;
      if (output) return output;
    } catch {
      /* try next shell candidate */
    }
  }
  return undefined;
}

function readWindowsExecutablePath(pid: number): string | undefined {
  const script = [
    `$process = Get-Process -Id ${pid} -ErrorAction Stop`,
    "if ($process.Path) { [Console]::Out.Write($process.Path) }",
  ].join("; ");
  return runPowerShell(script);
}

function parseTasklistImageName(tasklistOutput: string): string | undefined {
  const line = tasklistOutput.trim().split(/\r?\n/)[0] ?? "";
  if (!line || /^INFO:/i.test(line)) return undefined;
  const quoted = line.match(/^"([^"]+)"/);
  if (quoted?.[1]) return quoted[1];
  const first = line.split(",")[0]?.replace(/^"|"$/g, "").trim();
  return first || undefined;
}

function classifyDarwinComm(commOutput: string, expectedExe: string): ProcessIdentity {
  const out = commOutput.trim();
  if (!out) return "mismatch";
  if (path.isAbsolute(out)) {
    if (exePathsMatch(out, expectedExe)) return "match";
    if (expectedExe.startsWith(out) && out.length < expectedExe.length) return "unknown";
    return "mismatch";
  }
  return imageMatchesExpectedExe(out, expectedExe) ? "unknown" : "mismatch";
}

/**
 * Classify whether `pid` corresponds to the expected executable binary.
 *
 * - Linux: reads /proc/<pid>/exe symlink.
 * - Windows: queries Get-Process Path; falls back to tasklist image name.
 * - macOS: queries ps -p <pid> -o comm=.
 */
export function classifyProcessIdentity(pid: number, expectedExe: string): ProcessIdentity {
  if (!isProcessAlive(pid)) return "mismatch";
  const expected = expectedExe || "";
  if (!expected) return "unknown";

  try {
    if (process.platform === "linux") {
      try {
        const exeLink = fs.readlinkSync(`/proc/${pid}/exe`);
        return exePathsMatch(exeLink, expected) ? "match" : "mismatch";
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return code === "ENOENT" ? "mismatch" : "unknown";
      }
    }

    if (process.platform === "win32") {
      const executable = readWindowsExecutablePath(pid);
      if (executable) {
        return exePathsMatch(executable, expected) ? "match" : "mismatch";
      }

      try {
        const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 3000,
        }).trim();
        const image = parseTasklistImageName(out);
        if (!image) return "mismatch";
        return imageMatchesExpectedExe(image, expected) ? "unknown" : "mismatch";
      } catch {
        return "unknown";
      }
    }

    if (process.platform === "darwin") {
      try {
        const out = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "comm="], {
          encoding: "utf8",
          timeout: 3000,
        });
        return classifyDarwinComm(out, expected);
      } catch {
        return "unknown";
      }
    }
  } catch {
    return "unknown";
  }

  return "unknown";
}

function hasMihomoImageEvidence(pid: number, expectedExe: string): boolean {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3000,
      }).trim();
      const image = parseTasklistImageName(out);
      return image ? imageMatchesExpectedExe(image, expectedExe) : false;
    }
    if (process.platform === "linux") {
      try {
        const comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
        return imageMatchesExpectedExe(comm, expectedExe);
      } catch {
        return false;
      }
    }
    if (process.platform === "darwin") {
      const out = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "comm="], {
        encoding: "utf8",
        timeout: 3000,
      }).trim();
      return imageMatchesExpectedExe(out, expectedExe);
    }
  } catch {
    return false;
  }
  return false;
}

export function readPidRecord(layout: SashLayout = sashLayout()): PidRecord | undefined {
  try {
    if (!fs.existsSync(layout.pidFile)) return undefined;
    const raw = fs.readFileSync(layout.pidFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<PidRecord>;
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.exe === "string" &&
      typeof parsed.startedAt === "string"
    ) {
      return {
        pid: parsed.pid,
        exe: parsed.exe,
        startedAt: parsed.startedAt,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function clearPidRecord(layout: SashLayout = sashLayout()): void {
  try {
    fs.rmSync(layout.pidFile, { force: true });
  } catch {
    // best effort
  }
}

/**
 * Inspect whether Sash daemon is currently running, healthy, and report state.
 */
export async function evaluateRunning(
  layout: SashLayout = sashLayout(),
  settings?: SashSettings,
): Promise<RunningInfo> {
  const record = readPidRecord(layout);
  if (!record) {
    return { running: false };
  }

  if (!isProcessAlive(record.pid)) {
    return { running: false, stalePidFile: true, pid: record.pid };
  }

  const identity = classifyProcessIdentity(record.pid, record.exe);
  if (identity === "mismatch") {
    return { running: false, stalePidFile: true, pid: record.pid };
  }

  // Identity is "match" or "unknown" (conservative: considered running).
  const s = settings ?? loadSettings(layout);
  const api = new MihomoApi(s.controller, s.secret);
  let healthy = false;
  let version: string | undefined;
  try {
    version = await api.version();
    healthy = true;
  } catch {
    healthy = false;
    version = undefined;
  }

  return {
    running: true,
    pid: record.pid,
    healthy,
    version,
  };
}

const STRIPPED_ENV_KEYS = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_PAT",
  "GITHUB_ACCESS_TOKEN",
  "GH_PAT",
  "NPM_TOKEN",
  "NPM_AUTH_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_ID_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
]);

export function buildSanitizedEnv(sourceEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...sourceEnv };
  for (const key of Object.keys(childEnv)) {
    const upper = key.toUpperCase();
    const lower = key.toLowerCase();
    const isNpmAuthConfig =
      lower.startsWith("npm_config_") &&
      (lower.includes("authtoken") || lower.includes("auth_token") || lower.endsWith("_auth"));
    if (STRIPPED_ENV_KEYS.has(upper) || isNpmAuthConfig) {
      delete childEnv[key];
    }
  }
  return childEnv;
}

function tailFile(filePath: string, lineCount = 20): string {
  try {
    if (!fs.existsSync(filePath)) return "";
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return lines.slice(-lineCount).join("\n");
  } catch {
    return "";
  }
}

async function runTaskkill(pid: number, force: boolean): Promise<boolean> {
  const args = force ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"];
  return new Promise<boolean>((resolve) => {
    const killer = spawn("taskkill", args, {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("close", (code) => resolve(code === 0));
    killer.on("error", () => resolve(false));
  });
}

async function killUntrackedProcess(pid: number): Promise<void> {
  if (process.platform === "win32") {
    try {
      await runTaskkill(pid, true);
    } catch {
      // best effort
    }
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // best effort
  }
}

/**
 * Launch the background Mihomo daemon, record PID, and wait for API health.
 */
export async function startDaemon(opts?: StartOptions): Promise<{ pid: number }> {
  const layout = opts?.layout ?? sashLayout();
  const settings = opts?.settings ?? loadSettings(layout);
  const timeoutMs = opts?.timeoutMs ?? 10_000;

  const runningInfo = await evaluateRunning(layout, settings);
  if (runningInfo.running) {
    throw new Error(`Sash daemon is already running (PID=${runningInfo.pid})`);
  }
  if (runningInfo.stalePidFile) {
    clearPidRecord(layout);
  }

  if (!fs.existsSync(layout.coreExe)) {
    throw new Error(
      `Mihomo executable not found at ${layout.coreExe}. Run \`sash start\` to install it.`,
    );
  }
  if (!fs.existsSync(layout.configFile)) {
    throw new Error(
      `Mihomo config not found at ${layout.configFile}. Run \`sash start\` or \`sash sub set <url>\` first.`,
    );
  }

  fs.mkdirSync(layout.logsDir, { recursive: true });
  fs.mkdirSync(layout.stateDir, { recursive: true });

  const outFd = fs.openSync(layout.coreLogFile, "a", 0o600);
  let errFd: number;
  try {
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(layout.coreLogFile, 0o600);
      } catch {
        // ignore
      }
    }
    errFd = fs.openSync(layout.coreErrLogFile, "a", 0o600);
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(layout.coreErrLogFile, 0o600);
      } catch {
        // ignore
      }
    }
  } catch (err) {
    fs.closeSync(outFd);
    throw err;
  }

  const sanitizedEnv = buildSanitizedEnv();
  const child = spawn(layout.coreExe, ["-d", layout.root, "-f", layout.configFile], {
    cwd: layout.root,
    detached: true,
    stdio: ["ignore", outFd, errFd],
    windowsHide: true,
    env: sanitizedEnv,
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
    throw new Error("Failed to start Mihomo daemon process (no PID returned)");
  }

  const startedAt = new Date().toISOString();
  const record: PidRecord = { pid, exe: layout.coreExe, startedAt };
  atomicWriteFileSync(layout.pidFile, `${JSON.stringify(record, null, 2)}\n`);

  const api = new MihomoApi(settings.controller, settings.secret);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) {
      clearPidRecord(layout);
      const recentErr = tailFile(layout.coreErrLogFile, 20);
      const details = recentErr ? `\n${recentErr}` : "";
      throw new Error(`Failed to start Mihomo daemon: ${spawnError.message}${details}`);
    }

    if (!isProcessAlive(pid)) {
      clearPidRecord(layout);
      const recentErr = tailFile(layout.coreErrLogFile, 20);
      const details = recentErr
        ? `\nRecent errors from ${layout.coreErrLogFile}:\n${recentErr}`
        : "";
      throw new Error(
        `Mihomo daemon (PID=${pid}) exited unexpectedly during startup.${details}\nCheck logs at: ${layout.coreErrLogFile}`,
      );
    }

    // Poll lightly: process liveness + API answer only. Do NOT call
    // evaluateRunning here — its identity probe spawns PowerShell on Windows
    // and would starve the event loop inside a 300ms loop.
    try {
      await api.version();
      return { pid };
    } catch {
      // core not listening yet
    }

    await sleep(300);
  }

  // Timed out waiting for healthy API
  await killUntrackedProcess(pid);
  clearPidRecord(layout);
  const recentErr = tailFile(layout.coreErrLogFile, 20);
  const details = recentErr ? `\nRecent errors from ${layout.coreErrLogFile}:\n${recentErr}` : "";
  throw new Error(
    `Mihomo daemon started (PID=${pid}) but external-controller API did not become healthy within ${timeoutMs}ms.${details}\nCheck logs at: ${layout.coreErrLogFile}`,
  );
}

/**
 * Stop the running Mihomo daemon.
 *
 * Verifies process identity to avoid terminating unrelated processes.
 * Returns true if stopped or was not running; returns false if termination failed.
 */
export async function stopDaemon(opts?: {
  layout?: SashLayout;
  timeoutMs?: number;
}): Promise<boolean> {
  const layout = opts?.layout ?? sashLayout();
  const record = readPidRecord(layout);
  if (!record) {
    return true;
  }

  const pid = record.pid;
  if (!isProcessAlive(pid)) {
    clearPidRecord(layout);
    return true;
  }

  const identity = classifyProcessIdentity(pid, record.exe);
  if (identity === "mismatch") {
    log.warn(
      `PID ${pid} does not match expected executable ${record.exe}; removing stale PID file without killing.`,
    );
    clearPidRecord(layout);
    return true;
  }

  if (identity === "unknown") {
    const hasEvidence = hasMihomoImageEvidence(pid, record.exe);
    if (!hasEvidence) {
      // Keep the pid record: the process may still be ours, and dropping the
      // record would orphan it from Sash's tracking entirely.
      log.warn(
        `Refusing to stop PID ${pid}: process identity cannot be verified. ` +
          `The process may still be running; verify it manually (or delete ${layout.pidFile} if it is not ours).`,
      );
      return false;
    }
  }

  const totalTimeout = opts?.timeoutMs ?? 10_000;
  const graceMs = Math.min(5000, Math.floor(totalTimeout / 2));
  const forceMs = Math.max(1000, totalTimeout - graceMs);

  if (process.platform === "win32") {
    // Windows: graceful taskkill first
    const gracefulOk = await runTaskkill(pid, false);
    if (gracefulOk) {
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline && isProcessAlive(pid)) {
        await sleep(200);
      }
    }
    // If still alive, force kill
    if (isProcessAlive(pid)) {
      await runTaskkill(pid, true);
      const hardDeadline = Date.now() + forceMs;
      while (Date.now() < hardDeadline && isProcessAlive(pid)) {
        await sleep(100);
      }
    }
  } else {
    // POSIX: SIGTERM first
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") throw err;
    }

    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await sleep(200);
    }

    // If still alive, SIGKILL
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") throw err;
      }
      const hardDeadline = Date.now() + forceMs;
      while (Date.now() < hardDeadline && isProcessAlive(pid)) {
        await sleep(100);
      }
    }
  }

  if (isProcessAlive(pid)) {
    log.error(`Mihomo daemon is still running after stop attempt (PID=${pid}).`);
    return false;
  }

  clearPidRecord(layout);
  return true;
}

function recoverUnlockProbeBinary(target: string, probe: string): boolean {
  try {
    if (fs.existsSync(probe) && !fs.existsSync(target)) {
      fs.renameSync(probe, target);
    } else if (fs.existsSync(probe) && fs.existsSync(target)) {
      fs.rmSync(probe, { force: true });
    }
    return !fs.existsSync(probe);
  } catch {
    return false;
  }
}

async function recoverUnlockProbeWithRetry(target: string, probe: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (recoverUnlockProbeBinary(target, probe)) return true;
    await sleep(100);
  }
  return recoverUnlockProbeBinary(target, probe);
}

/**
 * Wait until the Mihomo binary file is unlocked by Windows file handles/antivirus.
 * On POSIX platforms, returns immediately.
 */
export async function waitForBinaryUnlocked(
  layout: SashLayout = sashLayout(),
  timeoutMs = 30_000,
): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }

  const target = layout.coreExe;
  if (!fs.existsSync(target)) {
    return;
  }

  const probe = path.join(path.dirname(target), `.${path.basename(target)}.unlock-probe`);

  recoverUnlockProbeBinary(target, probe);

  const deadline = Date.now() + timeoutMs;
  let delay = 150;

  while (Date.now() < deadline) {
    recoverUnlockProbeBinary(target, probe);
    try {
      fs.renameSync(target, probe);
      try {
        fs.renameSync(probe, target);
        return;
      } catch (secondErr) {
        // Antivirus may grab the freshly renamed file; retry the recovery a
        // few times before giving up so the core binary is never stranded
        // under the probe name.
        const recovered = await recoverUnlockProbeWithRetry(target, probe);
        if (!recovered) {
          throw new Error(
            `Failed to restore the core binary after the lock probe; it may currently be named ${probe}: ${
              (secondErr as Error).message
            }`,
          );
        }
      }
    } catch {
      await sleep(delay);
      delay = Math.min(1000, Math.floor(delay * 1.5));
    }
  }

  recoverUnlockProbeBinary(target, probe);
  throw new Error(
    `Mihomo binary is still locked after ${timeoutMs}ms: ${target}. Close programs using it and retry.`,
  );
}
