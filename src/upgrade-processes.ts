import path from "node:path";
import { isPlainObject } from "./json-shape.js";
import {
  findExecutableOnPath,
  isProcessAlive,
  runSanitizedCommandAsync,
  windowsSystemExecutable,
} from "./process.js";

export interface ProcessObservation {
  pid: number;
  name: string;
  commandLine: string | null;
}

/** Process arguments are inspected in memory only; errors never include unrelated command lines. */
export async function observeUpgradeProcesses(): Promise<ProcessObservation[]> {
  if (process.platform === "win32") {
    const command =
      findExecutableOnPath("pwsh.exe") ??
      windowsSystemExecutable(path.join("WindowsPowerShell", "v1.0", "powershell.exe"));
    const output = await runSanitizedCommandAsync(
      command,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine) | ConvertTo-Json -Compress",
      ],
      { timeoutMs: 15_000, maxBuffer: 8 * 1024 * 1024 },
    );
    let value: unknown;
    try {
      value = JSON.parse(output);
    } catch {
      throw new Error("Cannot read the Windows process census");
    }
    if (!Array.isArray(value) || value.length > 100_000)
      throw new Error("Invalid Windows process census");
    return value
      .map((row: unknown) => {
        if (
          !isPlainObject(row) ||
          typeof row.ProcessId !== "number" ||
          !Number.isSafeInteger(row.ProcessId) ||
          row.ProcessId < 0 ||
          typeof row.Name !== "string" ||
          (row.CommandLine !== null && typeof row.CommandLine !== "string")
        )
          throw new Error("Invalid Windows process observation");
        return { pid: row.ProcessId, name: row.Name, commandLine: row.CommandLine };
      })
      .filter((row) => isProcessAlive(row.pid));
  }
  const command = process.platform === "darwin" ? "/bin/ps" : findExecutableOnPath("ps");
  if (!command) throw new Error("Cannot find ps to verify Sash instance ownership");
  const output = await runSanitizedCommandAsync(command, ["-A", "-ww", "-o", "pid=,comm=,args="], {
    timeoutMs: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return output
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
      if (!match?.[1] || !match[2]) throw new Error("Cannot parse the process census");
      return {
        pid: Number(match[1]),
        name: path.basename(match[2]),
        commandLine: match[3]?.trim() || null,
      };
    })
    .filter((row) => isProcessAlive(row.pid));
}

export function assertNoUnknownSashDaemons(
  observations: ProcessObservation[],
  packageRoot: string,
  nodePaths: string[],
  knownPids: ReadonlySet<number>,
): void {
  const normalize = (value: string) => value.replaceAll("\\", "/").toLowerCase();
  const marker = normalize(path.join(packageRoot, "dist", "daemon-entry.js"));
  const names = new Set(nodePaths.map((node) => path.basename(node).toLowerCase()));
  const unknown = observations.filter(
    (row) =>
      isProcessAlive(row.pid) &&
      !knownPids.has(row.pid) &&
      row.pid !== process.pid &&
      row.pid !== process.ppid &&
      (row.commandLine
        ? normalize(row.commandLine).includes(marker)
        : names.has(row.name.toLowerCase())),
  );
  if (unknown.length)
    throw new Error(
      `Cannot verify all Sash owners; package replacement is blocked by PID ${unknown.map((row) => row.pid).join(", ")}`,
    );
}
