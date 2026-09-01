import spawn from "cross-spawn";
import { evaluateDaemon } from "../daemon-lifecycle.js";
import { log } from "../log.js";
import { runtimeContext } from "./shared.js";

const PACKAGE_NAME = "@astralyn/sash";

/**
 * `sash upgrade` upgrades Sash itself via npm. A running daemon must be
 * stopped first so code, lock and state schemas cannot straddle versions.
 */
export async function runUpgrade(opts: { version?: string } = {}): Promise<void> {
  const ctx = runtimeContext();
  const daemon = await evaluateDaemon(ctx.layout, ctx.settings);
  if (daemon.running) {
    throw new Error("stop Sash with `sash stop` before upgrading the package");
  }

  const target = opts.version ? `${PACKAGE_NAME}@${opts.version}` : `${PACKAGE_NAME}@latest`;
  log.info(`upgrading Sash via npm: ${target}`);
  const code = await new Promise<number>((resolve) => {
    const child = spawn("npm", ["install", "-g", target], { stdio: "inherit" });
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
