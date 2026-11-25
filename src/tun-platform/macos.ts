import fs from "node:fs/promises";
import os from "node:os";
import { errorMessage } from "../error-utils.js";
import type { SashLayout } from "../paths.js";
import { runSanitizedCommandAsync } from "../process.js";
import type { TunPlatform, TunPrivilege } from "../tun-service.js";
import { requireCoreFile, shellQuote } from "./shared.js";

const OSASCRIPT = "/usr/bin/osascript";

/** Sash 0.7.0 installed a LaunchDaemon helper; installing or removing the grant retires it. */
const LEGACY_CLEANUP = `
legacy=dev.astralyn.sash.helper
if /bin/launchctl print "system/$legacy" >/dev/null 2>&1; then
  /bin/launchctl bootout "system/$legacy" || true
fi
/bin/rm -f "/Library/LaunchDaemons/$legacy.plist"
/bin/rm -rf "/Library/Application Support/Sash"
`;

/**
 * Make the managed Core setuid root, executable by the installing user's
 * group — the approach macOS proxy clients have long used for TUN. Replacing
 * the file (a Core update) drops the grant with it.
 */
export function grantScript(core: string, user: string): string {
  return `set -eu
core=${shellQuote(core)}
user=${shellQuote(user)}
if [ ! -f "$core" ] || [ -L "$core" ]; then
  echo "Core not found at $core" >&2
  exit 1
fi
group=$(/usr/bin/id -gn "$user")
if /usr/bin/id -Gn "$user" | /usr/bin/tr ' ' '\\n' | /usr/bin/grep -qx admin; then group=admin; fi
/usr/sbin/chown "root:$group" "$core"
/bin/chmod 4750 "$core"
${LEGACY_CLEANUP}`;
}

/**
 * Return the Core to the user. A root Core leaves root-owned files in the
 * data folder (cache.db, geodata, provider caches); they go back too, so an
 * ordinary Core can keep updating them.
 */
export function revokeScript(core: string, home: string, user: string): string {
  return `set -eu
core=${shellQuote(core)}
home=${shellQuote(home)}
user=${shellQuote(user)}
group=$(/usr/bin/id -gn "$user")
if [ -f "$core" ] && [ ! -L "$core" ]; then
  /usr/sbin/chown "$user:$group" "$core"
  /bin/chmod 0755 "$core"
fi
if [ -d "$home" ] && [ ! -L "$home" ]; then
  /usr/sbin/chown -R -h "$user:$group" "$home"
fi
${LEGACY_CLEANUP}`;
}

async function runAsAdministrator(script: string, action: string): Promise<void> {
  // The script travels inside the command (base64 → /bin/sh), never as a
  // user-writable file that could change before root runs it.
  const encoded = Buffer.from(script, "utf8").toString("base64");
  try {
    await runSanitizedCommandAsync(
      OSASCRIPT,
      [
        "-e",
        `do shell script "printf %s '${encoded}' | /usr/bin/base64 -D | /bin/sh" with prompt "Sash wants to ${action}." with administrator privileges`,
      ],
      { timeoutMs: 300_000 },
    );
  } catch (error) {
    const message = errorMessage(error);
    if (/-128|cancel/i.test(message)) throw new Error("macOS administrator approval was cancelled");
    throw new Error(`Could not ${action}: ${message}`);
  }
}

export async function inspectSetuidCore(core: string): Promise<TunPrivilege> {
  const stat = await fs.stat(core).catch(() => undefined);
  if (!stat?.isFile()) return { state: "missing", detail: "Core is not installed" };
  if (stat.uid !== 0) return { state: "missing" };
  return (stat.mode & 0o4000) !== 0
    ? { state: "ready" }
    : { state: "stale", detail: "the Core is owned by root but is not setuid" };
}

export interface MacosTunPlatformDeps {
  run?: (script: string, action: string) => Promise<void>;
}

export function macosTunPlatform(deps: MacosTunPlatformDeps = {}): TunPlatform {
  const run = deps.run ?? runAsAdministrator;
  const user = () => os.userInfo().username;
  return {
    mechanism: "setuid",
    inspect: (layout: SashLayout) => inspectSetuidCore(layout.coreExe),
    async install(layout) {
      await requireCoreFile(layout);
      await run(grantScript(layout.coreExe, user()), "authorize its Core for TUN Mode");
    },
    async uninstall(layout) {
      await run(
        revokeScript(layout.coreExe, layout.root, user()),
        "remove the TUN Mode authorization from its Core",
      );
    },
  };
}
