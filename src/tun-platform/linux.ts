import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { TunHelperAuth } from "../contracts.js";
import { errorMessage } from "../error-utils.js";
import { atomicWriteFileSync, durableRemoveFileSync } from "../fs-atomic.js";
import type { SashLayout } from "../paths.js";
import { buildSanitizedEnv, findExecutableOnPath, runSanitizedCommandAsync } from "../process.js";
import type { TunInstallOptions, TunPlatform, TunPrivilege } from "../tun-service.js";
import { refuseElevationInTests, requireCoreFile } from "./shared.js";

/** What mihomo documents for running TUN without root. */
export const CORE_CAPABILITIES = "cap_net_admin,cap_net_bind_service=+ep";

/** Sash 0.7.0 installed a systemd helper; installing or removing the grant retires it. */
const LEGACY_CLEANUP = `
if [ -e /etc/systemd/system/sash-helper.service ]; then
  systemctl disable --now sash-helper.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/sash-helper.service
  systemctl daemon-reload || true
fi
rm -rf /usr/local/lib/sash /var/lib/sash-helper
`;

/**
 * Both scripts arrive on the elevated shell's stdin and take the Core path
 * as $1, so no user-writable file ever feeds the root shell. Replacing the
 * Core file (a Core update) drops its capabilities with it.
 */
export const GRANT_SCRIPT = `set -eu
core="$1"
if [ ! -f "$core" ] || [ -L "$core" ]; then
  echo "Core not found at $core" >&2
  exit 1
fi
if ! command -v setcap >/dev/null 2>&1; then
  echo "setcap is required (install libcap2-bin or libcap)" >&2
  exit 2
fi
setcap ${CORE_CAPABILITIES} "$core"
${LEGACY_CLEANUP}`;

export const REVOKE_SCRIPT = `set -eu
core="$1"
if [ -f "$core" ] && [ ! -L "$core" ] && command -v setcap >/dev/null 2>&1; then
  setcap -r "$core" 2>/dev/null || true
fi
${LEGACY_CLEANUP}`;

export type Runner = (
  cmd: string,
  args: string[],
  options: { timeoutMs: number; input?: string },
) => Promise<string>;

const defaultRunner: Runner = (cmd, args, { timeoutMs, input }) =>
  runSanitizedCommandAsync(cmd, args, {
    timeoutMs,
    input,
    maxBuffer: 256 * 1024,
    stderrInError: true,
  });

/**
 * pkexec is the interactive path on a desktop; sudo -n is used only when the
 * user opted in with SASH_TUN_HELPER_AUTH=sudo. A refused pkexec prompt is
 * never retried through another mechanism.
 */
export function elevationCommand(env: NodeJS.ProcessEnv): { cmd: string; args: string[] } {
  if (process.geteuid?.() === 0) return { cmd: "/bin/sh", args: ["-s"] };
  const sudo = findExecutableOnPath("sudo", env);
  if (env.SASH_TUN_HELPER_AUTH === "sudo" && sudo)
    return { cmd: sudo, args: ["-n", "/bin/sh", "-s"] };
  const pkexec = findExecutableOnPath("pkexec", env);
  if (pkexec) return { cmd: pkexec, args: ["/bin/sh", "-s"] };
  throw new Error(
    "TUN authorization needs pkexec, or sudo with SASH_TUN_HELPER_AUTH=sudo; neither was found",
  );
}

function getcapPath(env: NodeJS.ProcessEnv): string | undefined {
  // sbin is often missing from a desktop user's PATH.
  return (
    findExecutableOnPath("getcap", env) ??
    ["/usr/sbin/getcap", "/sbin/getcap"].find((candidate) => existsSync(candidate))
  );
}

/**
 * True when `getcap` shows both capabilities effective and permitted. libcap
 * prints `<file> cap_net_admin,cap_net_bind_service=ep`; older releases print
 * `<file> = cap_net_admin,cap_net_bind_service+ep`.
 */
export function parseGetcap(output: string, core: string): boolean {
  const text = output.trim();
  const clauses = text.startsWith(core) ? text.slice(core.length) : text;
  const granted = new Set<string>();
  for (const [, list = "", flags = ""] of clauses.matchAll(/((?:cap_[a-z_]+,?)+)[=+]([eip]+)/g)) {
    if (flags.includes("e") && flags.includes("p"))
      for (const capability of list.split(",")) granted.add(capability);
  }
  return granted.has("cap_net_admin") && granted.has("cap_net_bind_service");
}

function helperAuthFile(layout: SashLayout): string {
  return path.join(layout.stateDir, "tun-helper-auth");
}

function readStoredHelperAuth(layout: SashLayout): TunHelperAuth | undefined {
  try {
    const value = readFileSync(helperAuthFile(layout), "utf8").trim();
    return value === "sudo" || value === "pkexec" ? value : undefined;
  } catch {
    return undefined;
  }
}

function storeHelperAuth(layout: SashLayout, value: TunHelperAuth): void {
  try {
    if (value === "sudo") atomicWriteFileSync(helperAuthFile(layout), "sudo\n");
    else durableRemoveFileSync(helperAuthFile(layout));
  } catch {}
}

export function helperAuthEnvironment(
  base: NodeJS.ProcessEnv,
  layout: SashLayout,
  options?: TunInstallOptions,
): { env: NodeJS.ProcessEnv; explicit: TunHelperAuth | undefined } {
  const raw = options?.helperAuth ?? base.SASH_TUN_HELPER_AUTH?.trim();
  const explicit = raw ? (raw === "sudo" ? "sudo" : "pkexec") : undefined;
  const env = { ...base };
  if (explicit) env.SASH_TUN_HELPER_AUTH = explicit;
  else {
    delete env.SASH_TUN_HELPER_AUTH;
    const stored = readStoredHelperAuth(layout);
    if (stored) env.SASH_TUN_HELPER_AUTH = stored;
  }
  return { env, explicit };
}

export function linuxTunPlatform(
  deps: { run?: Runner; env?: NodeJS.ProcessEnv } = {},
): TunPlatform {
  const run = deps.run ?? defaultRunner;
  const env = () => deps.env ?? buildSanitizedEnv();

  async function elevate(
    script: string,
    layout: SashLayout,
    action: string,
    options?: TunInstallOptions,
  ): Promise<void> {
    refuseElevationInTests(action);
    const choice = helperAuthEnvironment(env(), layout, options);
    if (choice.explicit === "pkexec") storeHelperAuth(layout, "pkexec");
    const { cmd, args } = elevationCommand(choice.env);
    try {
      await run(cmd, [...args, "--", layout.coreExe], { timeoutMs: 120_000, input: script });
    } catch (error) {
      throw new Error(
        `Could not ${action}: ${errorMessage(error)}. Approve the pkexec prompt, or rerun with SASH_TUN_HELPER_AUTH=sudo when sudoers allows it.`,
      );
    }
    if (choice.explicit) storeHelperAuth(layout, choice.explicit);
  }

  return {
    mechanism: "capabilities",
    async inspect(layout): Promise<TunPrivilege> {
      const stat = await fs.stat(layout.coreExe).catch(() => undefined);
      if (!stat?.isFile()) return { state: "missing", detail: "Core is not installed" };
      const getcap = getcapPath(env());
      if (!getcap) return { state: "unknown", detail: "getcap is not installed" };
      try {
        const output = await run(getcap, [layout.coreExe], { timeoutMs: 5_000 });
        return parseGetcap(output, layout.coreExe) ? { state: "ready" } : { state: "missing" };
      } catch (error) {
        return { state: "unknown", detail: errorMessage(error) };
      }
    },
    async install(layout, options) {
      await requireCoreFile(layout);
      await elevate(GRANT_SCRIPT, layout, "authorize the Core for TUN Mode", options);
    },
    async uninstall(layout, options) {
      await elevate(
        REVOKE_SCRIPT,
        layout,
        "remove the TUN Mode authorization from the Core",
        options,
      );
    },
  };
}
