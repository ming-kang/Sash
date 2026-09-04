import type { SpawnOptions } from "node:child_process";
import spawn from "cross-spawn";
import { log } from "../log.js";
import { buildSanitizedEnv } from "../process.js";
import { resolveRuntimeOwner } from "../runtime-owner.js";
import { runtimeContext } from "./shared.js";

const PACKAGE_NAME = "@astralyn/sash";
const STRICT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SAFE_DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export function validateUpgradeVersion(value: string): string {
  if (value !== value.trim() || !value) {
    throw new Error(`Invalid Sash package version or dist-tag: ${JSON.stringify(value)}`);
  }
  if (STRICT_SEMVER.test(value)) return value;
  if (SAFE_DIST_TAG.test(value) && !/^v?\d+(?:\.|$)/i.test(value)) return value;
  throw new Error(`Invalid Sash package version or dist-tag: ${JSON.stringify(value)}`);
}

export function buildUpgradeSpawnOptions(sourceEnv: NodeJS.ProcessEnv = process.env): SpawnOptions {
  return { stdio: "inherit", env: buildSanitizedEnv(sourceEnv) };
}

/**
 * `sash upgrade` upgrades Sash itself via npm. A running daemon must be
 * stopped first so code, lock and state schemas cannot straddle versions.
 */
export async function runUpgrade(opts: { version?: string } = {}): Promise<void> {
  const ctx = runtimeContext();
  const owner = await resolveRuntimeOwner(ctx);
  if (owner.kind !== "offline") {
    throw new Error("stop Sash with `sash stop` before upgrading the package");
  }

  const version = validateUpgradeVersion(opts.version ?? "latest");
  const target = `${PACKAGE_NAME}@${version}`;
  log.info(`upgrading Sash via npm: ${target}`);
  const code = await new Promise<number>((resolve) => {
    const child = spawn("npm", ["install", "-g", target], buildUpgradeSpawnOptions());
    child.on("error", (err) => {
      log.error(`failed to launch npm: ${err.message}`);
      resolve(1);
    });
    child.on("close", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) {
    throw new Error(
      `npm exited with code ${code}. Try running the command manually: npm install -g ${target}`,
    );
  }
  log.ok("Sash upgraded. Run `sash version` to verify, then start it normally.");
}
