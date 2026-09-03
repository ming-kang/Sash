import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./fs-atomic.js";
import type { SashLayout } from "./paths.js";
import { buildSanitizedEnv } from "./process.js";

export type CoreConfigTestRunner = (executable: string, args: string[]) => Promise<void> | void;

function defaultRunner(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: "utf8",
        env: buildSanitizedEnv(),
        maxBuffer: 1024 * 1024,
        timeout: 20_000,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve();
          return;
        }
        reject(Object.assign(err, { stdout, stderr }));
      },
    );
  });
}

function errorOutput(err: unknown): string {
  if (typeof err !== "object" || err === null) return String(err);
  const record = err as { message?: unknown; stderr?: unknown; stdout?: unknown };
  for (const value of [record.stderr, record.stdout, record.message]) {
    const text = Buffer.isBuffer(value)
      ? value.toString("utf8").trim()
      : String(value ?? "").trim();
    if (text) return text.slice(0, 1000);
  }
  return "unknown validation error";
}

export async function validateCoreConfigFile(
  executable: string,
  configFile: string,
  layout: SashLayout,
  runner: CoreConfigTestRunner = defaultRunner,
): Promise<void> {
  if (!fs.existsSync(executable)) {
    throw new Error(`Core executable is missing: ${executable}`);
  }
  if (!fs.existsSync(configFile)) {
    throw new Error(`Core configuration is missing: ${configFile}`);
  }
  try {
    await runner(executable, ["-t", "-d", layout.root, "-f", configFile]);
  } catch (err) {
    throw new Error(`Core rejected generated configuration: ${errorOutput(err)}`);
  }
}

export async function validateCoreConfigTextWithExecutable(
  executable: string,
  yaml: string,
  layout: SashLayout,
  runner: CoreConfigTestRunner = defaultRunner,
): Promise<void> {
  if (!fs.existsSync(executable)) {
    throw new Error(`Core executable is missing: ${executable}`);
  }
  fs.mkdirSync(layout.tempDir, { recursive: true });
  const candidate = path.join(
    layout.tempDir,
    `config-validate-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`,
  );
  try {
    atomicWriteFileSync(candidate, yaml);
    await validateCoreConfigFile(executable, candidate, layout, runner);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Core rejected generated configuration:")) {
      throw err;
    }
    throw new Error(`Core rejected generated configuration: ${errorOutput(err)}`);
  } finally {
    fs.rmSync(candidate, { force: true });
  }
}

/** Validate the exact generated YAML with the installed Core before committing it. */
export function validateCoreConfigText(
  yaml: string,
  layout: SashLayout,
  runner: CoreConfigTestRunner = defaultRunner,
): Promise<void> {
  return validateCoreConfigTextWithExecutable(layout.coreExe, yaml, layout, runner);
}
