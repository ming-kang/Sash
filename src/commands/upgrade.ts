import spawn from "cross-spawn";
import { log } from "../log.js";

const PACKAGE_NAME = "@astralyn/sash";

/**
 * `sash upgrade` upgrades Sash itself via npm. The running core is untouched
 * (it is an independent detached process); the new CLI takes effect on the
 * next invocation.
 */
export async function runUpgrade(opts: { version?: string } = {}): Promise<void> {
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
  log.ok("Sash upgraded. Run `sash version` to verify; the running core was not affected.");
}
