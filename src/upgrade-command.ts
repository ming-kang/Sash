import { spawn } from "node:child_process";
import { buildSanitizedEnv, killProcessGracefully } from "./process.js";
import type { UpgradeAccess } from "./upgrade-access.js";

export function upgradeChildEnv(source = process.env): NodeJS.ProcessEnv {
  const env = buildSanitizedEnv(source);
  for (const key of Object.keys(env))
    if (
      key.toLowerCase().startsWith("npm_config_") ||
      [
        "NODE_OPTIONS",
        "NODE_PATH",
        "SASH_DEVELOPMENT",
        "SASH_AUTOSTART_NODE",
        "SASH_AUTOSTART_ENTRY",
      ].includes(key.toUpperCase())
    )
      delete env[key];
  return env;
}

export interface UpgradeCommandOptions {
  cwd: string;
  purpose: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  upgradeAccess?: UpgradeAccess;
}

/** Owned child handles, bounded output and an explicit environment for npm and candidate probes. */
export async function runUpgradeCommand(
  command: string,
  args: string[],
  options: UpgradeCommandOptions,
): Promise<string> {
  options.signal?.throwIfAborted();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: {
      ...upgradeChildEnv(options.env),
      ...(options.upgradeAccess
        ? {
            SASH_UPGRADE_TRANSACTION: options.upgradeAccess.transactionId,
            SASH_UPGRADE_GRANT: options.upgradeAccess.grant,
          }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let failure: Error | undefined;
  let termination: Promise<boolean> | undefined;
  const stop = (reason: Error): void => {
    failure ??= reason;
    if (termination || !child.pid) return;
    termination = killProcessGracefully(child.pid, {
      timeoutMs: 5000,
      verify: () => (child.exitCode === null && child.signalCode === null ? "match" : "mismatch"),
    });
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length + chunk.length > 2 * 1024 * 1024)
      stop(new Error(`${options.purpose} produced too much output`));
    else stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-32 * 1024);
  });
  const abort = (): void => stop(new Error(`${options.purpose} cancelled`));
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => stop(new Error(`${options.purpose} timed out`)),
    options.timeoutMs ?? 30_000,
  );
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (termination && !(await termination))
      throw new Error(`${options.purpose} could not be confirmed stopped`);
    if (failure) throw failure;
    if (code !== 0) {
      const detail = (stderr.trim() || stdout.slice(-32 * 1024))
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<redacted>@")
        .trim();
      throw new Error(
        `${options.purpose} failed (${code ?? "signal"})${detail ? `: ${detail}` : ""}`,
      );
    }
    return stdout;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
