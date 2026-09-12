import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentPackageRoot } from "../package-info.js";
import { type SashLayout, sashLayout } from "../paths.js";
import { buildSanitizedEnv } from "../process.js";
import type { RegisteredAutostartState } from "./contract.js";

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

export interface AutostartBackend {
  inspect(): Promise<RegisteredAutostartState>;
  set(enabled: boolean): Promise<void>;
}

export interface AutostartOptions {
  layout?: SashLayout;
  platform?: NodeJS.Platform;
  homedir?: string;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  nodePath?: string;
  runCommand?: AutostartCommand;
}

export interface AutostartContext {
  platform: NodeJS.Platform;
  homedir: string;
  controlDir: string;
  dataDir: string;
  packageRoot: string;
  nodePath: string;
  entryPath: string;
  env: NodeJS.ProcessEnv;
  run(command: string, args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<CommandResult>;
}

function absoluteEnvPath(value: string | undefined, fallback: string): string {
  const configured = value?.trim();
  return configured && path.isAbsolute(configured) ? configured : fallback;
}

export function autostartContext(options: AutostartOptions = {}): AutostartContext {
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir();
  const env = buildSanitizedEnv(options.env ?? process.env);
  const packageRoot = options.packageRoot ?? currentPackageRoot();
  const controlDir = path.join(
    absoluteEnvPath(env.LOCALAPPDATA, path.join(homedir, "AppData", "Local")),
    "Sash",
    "autostart",
  );
  const runCommand = options.runCommand ?? runAutostartCommand;
  return {
    platform,
    homedir,
    controlDir,
    dataDir: path.resolve((options.layout ?? sashLayout()).root),
    packageRoot,
    nodePath: options.nodePath ?? process.execPath,
    entryPath: path.join(packageRoot, "dist", "autostart-entry.js"),
    env,
    run: (command, args, extraEnv) =>
      runCommand(command, args, buildSanitizedEnv({ ...env, ...extraEnv })),
  };
}

export function assertLauncherValue(value: string): void {
  if (
    !value ||
    Array.from(value).some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127)
  ) {
    throw new Error("Autostart paths must be nonempty and contain no control characters");
  }
}

export function launcherFilesExist(ctx: AutostartContext): boolean {
  try {
    return [ctx.nodePath, ctx.entryPath].every((file) => fs.statSync(file).isFile());
  } catch {
    return false;
  }
}
