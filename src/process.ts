import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, durableRemoveFileSync, durableRenameSync } from "./fs-atomic.js";

/**
 * Low-level process toolkit: liveness probes, fail-closed identity
 * classification, graceful termination, PID records and sanitized child
 * environments. Contains no daemon- or core-specific policy — that lives in
 * daemon.ts (core child supervision) and daemon-lifecycle.ts (sashd control).
 */

export interface PidRecord {
  pid: number;
  exe: string;
  startedAt: string;
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

/**
 * Best-effort full command line of a process. Needed because the sash daemon
 * is a Node process: its executable path (node.exe) is shared by unrelated
 * programs, so identity must come from the script argument instead.
 */
export function readProcessCommandLine(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const parts = raw.split("\0").filter((s) => s.length > 0);
      return parts.length > 0 ? parts.join(" ") : undefined;
    }
    if (process.platform === "win32") {
      const script = [
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop`,
        "if ($p.CommandLine) { [Console]::Out.Write($p.CommandLine) }",
      ].join("; ");
      return runPowerShell(script);
    }
    if (process.platform === "darwin") {
      const out = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        timeout: 3000,
      }).trim();
      return out || undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** True when the process command line contains the given marker (path fragment). */
export function commandLineContains(pid: number, marker: string): boolean {
  const cmdline = readProcessCommandLine(pid);
  if (!cmdline) return false;
  const normalize = (s: string) => s.replace(/\\/g, "/").toLowerCase();
  return normalize(cmdline).includes(normalize(marker));
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

export const TAIL_FILE_CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_LINE_BYTES = 64 * 1024;

/** Last non-empty lines of a file, for surfacing daemon/core startup errors. */
export function tailFile(filePath: string, lineCount = 20): string {
  if (!Number.isSafeInteger(lineCount) || lineCount <= 0) return "";
  let fd: number | undefined;
  try {
    const size = fs.statSync(filePath).size;
    if (size <= 0) return "";
    fd = fs.openSync(filePath, "r");
    let position = size;
    let pending = "";
    const lines: string[] = [];

    while (position > 0 && lines.length < lineCount) {
      const bytesToRead = Math.min(TAIL_FILE_CHUNK_BYTES, position);
      position -= bytesToRead;
      const chunk = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = fs.readSync(fd, chunk, 0, bytesToRead, position);
      const parts = (chunk.subarray(0, bytesRead).toString("utf8") + pending).split(/\r?\n/);
      pending = parts.shift() ?? "";
      // A pathological unterminated log line must not turn an error-reporting
      // path back into a whole-file allocation.
      if (Buffer.byteLength(pending) > MAX_TAIL_LINE_BYTES) {
        pending = pending.slice(-MAX_TAIL_LINE_BYTES);
      }
      for (let index = parts.length - 1; index >= 0 && lines.length < lineCount; index--) {
        const line = parts[index];
        if (line?.trim()) lines.push(line);
      }
    }
    if (lines.length < lineCount && pending.trim()) lines.push(pending);
    return lines.reverse().join("\n");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
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

export interface KillProcessOptions {
  timeoutMs?: number;
  /** Revalidate ownership immediately before every termination signal. */
  verify: () => ProcessIdentity | Promise<ProcessIdentity>;
}

async function processIdentityMatches(verify: KillProcessOptions["verify"]): Promise<boolean> {
  try {
    return (await verify()) === "match";
  } catch {
    return false;
  }
}

/** Terminate a process without ever signalling a PID whose ownership became uncertain. */
export async function killProcessGracefully(
  pid: number,
  opts: KillProcessOptions,
): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  if (!(await processIdentityMatches(opts.verify))) return false;

  const totalTimeout = opts.timeoutMs ?? 10_000;
  const graceMs = Math.min(5000, Math.floor(totalTimeout / 2));
  const forceMs = Math.max(1000, totalTimeout - graceMs);

  if (process.platform === "win32") {
    const gracefulOk = await runTaskkill(pid, false);
    if (gracefulOk) {
      const deadline = Date.now() + graceMs;
      while (Date.now() < deadline && isProcessAlive(pid)) {
        await sleep(200);
      }
    }
    if (isProcessAlive(pid)) {
      if (!(await processIdentityMatches(opts.verify))) return false;
      await runTaskkill(pid, true);
      const hardDeadline = Date.now() + forceMs;
      while (Date.now() < hardDeadline && isProcessAlive(pid)) {
        await sleep(100);
      }
    }
  } else {
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

    if (isProcessAlive(pid)) {
      if (!(await processIdentityMatches(opts.verify))) return false;
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

  return !isProcessAlive(pid);
}

export function readPidRecord(pidFile: string): PidRecord | undefined {
  try {
    if (!fs.existsSync(pidFile)) return undefined;
    const raw = fs.readFileSync(pidFile, "utf8");
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

export function writePidRecord(pidFile: string, record: PidRecord): void {
  atomicWriteFileSync(pidFile, `${JSON.stringify(record, null, 2)}\n`);
}

export function clearPidRecord(pidFile: string): void {
  try {
    fs.rmSync(pidFile, { force: true });
  } catch {
    // best effort
  }
}

export function binaryUnlockProbePath(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.unlock-probe`);
}

function regularFileStat(file: string): fs.Stats | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error(`Binary path is not a regular file: ${file}`);
    return stat;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function fileDigestSync(file: string): string {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** Restore a binary stranded by an interrupted Windows unlock probe. */
export function recoverBinaryUnlockProbe(target: string): void {
  const probe = binaryUnlockProbePath(target);
  const probeStat = regularFileStat(probe);
  if (!probeStat) return;
  const targetStat = regularFileStat(target);
  if (!targetStat) {
    durableRenameSync(probe, target);
    return;
  }
  if (probeStat.size === targetStat.size && fileDigestSync(probe) === fileDigestSync(target)) {
    durableRemoveFileSync(probe);
    return;
  }
  throw new Error(
    `Core binary and unlock probe both exist with different content; preserved ${target} and ${probe}`,
  );
}

async function recoverUnlockProbeWithRetry(target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      recoverBinaryUnlockProbe(target);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < 3) await sleep(100);
    }
  }
  throw lastError;
}

/**
 * Wait until a binary file is unlocked by Windows file handles/antivirus.
 * On POSIX platforms, returns immediately.
 */
export async function waitForBinaryUnlocked(target: string, timeoutMs = 30_000): Promise<void> {
  await recoverUnlockProbeWithRetry(target);
  if (process.platform !== "win32" || !fs.existsSync(target)) return;

  const probe = binaryUnlockProbePath(target);
  const deadline = Date.now() + timeoutMs;
  let delay = 150;

  while (Date.now() < deadline) {
    try {
      durableRenameSync(target, probe);
    } catch {
      await sleep(delay);
      delay = Math.min(1000, Math.floor(delay * 1.5));
      continue;
    }

    try {
      durableRenameSync(probe, target);
      return;
    } catch (secondError) {
      try {
        await recoverUnlockProbeWithRetry(target);
        return;
      } catch (recoveryError) {
        throw new Error(
          `Failed to restore the binary after the lock probe; preserved state near ${probe}: ${(secondError as Error).message}; recovery failed: ${(recoveryError as Error).message}`,
        );
      }
    }
  }

  await recoverUnlockProbeWithRetry(target);
  throw new Error(
    `Binary is still locked after ${timeoutMs}ms: ${target}. Close programs using it and retry.`,
  );
}
