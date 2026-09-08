import { execFile } from "node:child_process";
import { buildSanitizedEnv } from "../process.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type AutostartCommand = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<CommandResult>;

export const runAutostartCommand: AutostartCommand = (command, args, env) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        encoding: "utf8",
        env: buildSanitizedEnv(env),
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      },
    );
    child.stdin?.end();
  });

export function requireCommandSuccess(result: CommandResult): void {
  if (result.code !== 0) {
    throw new Error(
      "Autostart command failed: " +
        (result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`).slice(0, 1000),
    );
  }
}
