import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseTunHelperAuth, type TunHelperAuth } from "../contracts.js";
import { errorMessage } from "../error-utils.js";
import { atomicWriteFileSync, durableRemoveFileSync } from "../fs-atomic.js";
import type { SashLayout } from "../paths.js";
import { buildSanitizedEnv, findExecutableOnPath, runSanitizedCommandAsync } from "../process.js";
import type { TunInstallOptions, TunPlatform, TunPrivilege } from "../tun-service.js";
import { requireCoreFile } from "./shared.js";

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
 * The privileged TUN guard: root:root 0755, installed once by the grant
 * script and invoked through the sudoers rule. setup installs the blackhole
 * fallback routes first — they are what keeps a killed Core fail-closed —
 * then redoes the systemd-resolved integration sing-tun only attempts once
 * per interface, unprivileged and without retries.
 *
 * The heredoc embedding keeps the content fixed; the device name only ever
 * arrives as a validated argv word, never inside shell text.
 */
export const TUN_GUARD_SCRIPT = `#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

usage() {
  echo "usage: sash-tun-guard setup <device> | teardown" >&2
  exit 2
}

if [ $# -lt 1 ]; then
  usage
fi
verb=$1

device=""
if [ "$verb" = "setup" ]; then
  if [ $# -lt 2 ]; then
    echo "sash-tun-guard: setup requires a device name" >&2
    exit 2
  fi
  device=$2
  case $device in
    "" | *[!a-zA-Z0-9._-]*)
      echo "sash-tun-guard: invalid device name" >&2
      exit 2
      ;;
  esac
  if [ \${#device} -gt 32 ]; then
    echo "sash-tun-guard: device name too long" >&2
    exit 2
  fi
elif [ "$verb" != "teardown" ]; then
  usage
fi

exec 9>/run/sash-tun-guard.lock
if ! flock -w 30 9; then
  echo "sash-tun-guard: timed out waiting for the guard lock" >&2
  exit 1
fi

table=2022

if [ "$verb" = "teardown" ]; then
  ip route del blackhole default metric 100 table "$table" 2>/dev/null || true
  ip -6 route del blackhole default metric 100 table "$table" 2>/dev/null || true
  echo "sash-tun-guard: blackhole fallback removed from table $table" >&2
  exit 0
fi

ip route replace blackhole default metric 100 table "$table"
ip -6 route replace blackhole default metric 100 table "$table" 2>/dev/null || true

if ! command -v resolvectl >/dev/null 2>&1; then
  echo "sash-tun-guard: resolvectl is missing; skipping systemd-resolved integration" >&2
  exit 0
fi
if ! command -v systemctl >/dev/null 2>&1 || ! systemctl is-active --quiet systemd-resolved 2>/dev/null; then
  echo "sash-tun-guard: systemd-resolved is not active; skipping DNS integration" >&2
  exit 0
fi

waited=0
while [ $waited -lt 50 ]; do
  if ip link show dev "$device" >/dev/null 2>&1; then
    break
  fi
  waited=$((waited + 1))
  sleep 0.2
done
if ! ip link show dev "$device" >/dev/null 2>&1; then
  echo "sash-tun-guard: interface $device did not appear" >&2
  exit 1
fi

attempt=1
while [ $attempt -le 5 ]; do
  resolvectl dns "$device" 198.18.0.2 >/dev/null 2>&1 || true
  resolvectl domain "$device" "~." >/dev/null 2>&1 || true
  resolvectl default-route "$device" true >/dev/null 2>&1 || true
  link_state=$(resolvectl status "$device" 2>/dev/null || true)
  if echo "$link_state" | grep -F "198.18.0.2" >/dev/null 2>&1 && echo "$link_state" | grep -F "~." >/dev/null 2>&1; then
    echo "sash-tun-guard: systemd-resolved configured on $device" >&2
    exit 0
  fi
  attempt=$((attempt + 1))
  if [ $attempt -le 5 ]; then
    sleep 1
  fi
done

echo "sash-tun-guard: could not configure systemd-resolved on $device" >&2
exit 1
`;

const GUARD_INSTALL = `
guard=/usr/local/libexec/sash-tun-guard
guard_tmp=/usr/local/libexec/.sash-tun-guard.new.$$
guard_installed=0
if (
  mkdir -p /usr/local/libexec &&
  cat > "$guard_tmp" <<'SASH_TUN_GUARD_EOF' &&
${TUN_GUARD_SCRIPT}SASH_TUN_GUARD_EOF
  chmod 0755 "$guard_tmp" &&
  chown root:root "$guard_tmp" &&
  mv -f "$guard_tmp" "$guard"
); then
  guard_installed=1
else
  echo "warning: could not install $guard; the TUN kill-switch fallback is unavailable" >&2
fi
rm -f "$guard_tmp" 2>/dev/null || true

sudoers_user=$(printenv SUDO_USER 2>/dev/null || true)
if [ -z "$sudoers_user" ]; then
  pkexec_uid=$(printenv PKEXEC_UID 2>/dev/null || true)
  if [ -n "$pkexec_uid" ]; then
    sudoers_user=$(id -nu "$pkexec_uid" 2>/dev/null || true)
  fi
fi
case $sudoers_user in
  "" | *[!a-zA-Z0-9._-]* | root)
    sudoers_user=""
    ;;
esac
if [ \${#sudoers_user} -gt 32 ]; then
  sudoers_user=""
fi

if [ "$guard_installed" = 1 ]; then
  if [ -z "$sudoers_user" ]; then
    if printenv SUDO_USER >/dev/null 2>&1 || printenv PKEXEC_UID >/dev/null 2>&1; then
      echo "warning: could not identify a sudoers-safe invoking user; the TUN guard will not run automatically" >&2
    fi
  elif ! command -v sudo >/dev/null 2>&1; then
    echo "warning: sudo is not installed; the TUN guard script cannot run without a sudoers rule" >&2
  else
    sudoers_tmp=/etc/sudoers.d/.sash-tun-guard.$$
    if ! (
      mkdir -p /etc/sudoers.d &&
      printf '%s\\n' "$sudoers_user ALL=(root) NOPASSWD: $guard" > "$sudoers_tmp" &&
      chmod 0440 "$sudoers_tmp" &&
      visudo -cf "$sudoers_tmp" >/dev/null 2>&1 &&
      mv -f "$sudoers_tmp" /etc/sudoers.d/sash-tun-guard
    ); then
      echo "warning: could not install the sudoers rule for $guard; the TUN guard will not run automatically" >&2
    fi
    rm -f "$sudoers_tmp" 2>/dev/null || true
  fi
fi
`;

const GUARD_REMOVE = `
rm -f /etc/sudoers.d/sash-tun-guard
rm -f /usr/local/libexec/sash-tun-guard
ip route del blackhole default metric 100 table 2022 2>/dev/null || true
ip -6 route del blackhole default metric 100 table 2022 2>/dev/null || true
if command -v resolvectl >/dev/null 2>&1; then
  resolvectl revert Meta >/dev/null 2>&1 || true
fi
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
${LEGACY_CLEANUP}${GUARD_INSTALL}`;

export const REVOKE_SCRIPT = `set -eu
core="$1"
if [ -f "$core" ] && [ ! -L "$core" ] && command -v setcap >/dev/null 2>&1; then
  setcap -r "$core" 2>/dev/null || true
fi
${GUARD_REMOVE}${LEGACY_CLEANUP}`;

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
 * caller resolved a sudo preference. A refused pkexec prompt is never retried
 * through another mechanism.
 */
export function elevationCommand(
  env: NodeJS.ProcessEnv,
  preference?: TunHelperAuth,
): { cmd: string; args: string[] } {
  if (process.geteuid?.() === 0) return { cmd: "/bin/sh", args: ["-s"] };
  const sudo = findExecutableOnPath("sudo", env);
  if (preference === "sudo" && sudo) return { cmd: sudo, args: ["-n", "/bin/sh", "-s"] };
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

/**
 * The file only ever records "remember sudo": pkexec is the default and needs
 * no state, so any other content means nothing was remembered.
 */
function readStoredHelperAuth(layout: SashLayout): "sudo" | undefined {
  try {
    return readFileSync(helperAuthFile(layout), "utf8").trim() === "sudo" ? "sudo" : undefined;
  } catch {
    return undefined;
  }
}

function rememberSudoPreference(layout: SashLayout, remember: boolean): void {
  try {
    if (remember) atomicWriteFileSync(helperAuthFile(layout), "sudo\n");
    else durableRemoveFileSync(helperAuthFile(layout));
  } catch {}
}

function requestedHelperAuth(
  env: NodeJS.ProcessEnv,
  options?: TunInstallOptions,
): TunHelperAuth | undefined {
  return options?.helperAuth ?? parseTunHelperAuth(env.SASH_TUN_HELPER_AUTH?.trim());
}

export function resolveHelperAuth(
  layout: SashLayout,
  env: NodeJS.ProcessEnv,
  options?: TunInstallOptions,
): TunHelperAuth | undefined {
  return requestedHelperAuth(env, options) ?? readStoredHelperAuth(layout);
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
    const environment = env();
    const explicit = requestedHelperAuth(environment, options);
    if (explicit === "pkexec") rememberSudoPreference(layout, false);
    const { cmd, args } = elevationCommand(
      environment,
      resolveHelperAuth(layout, environment, options),
    );
    try {
      await run(cmd, [...args, "--", layout.coreExe], { timeoutMs: 120_000, input: script });
    } catch (error) {
      throw new Error(
        `Could not ${action}: ${errorMessage(error)}. Approve the pkexec prompt, or rerun with SASH_TUN_HELPER_AUTH=sudo when sudoers allows it.`,
      );
    }
    if (explicit === "sudo") rememberSudoPreference(layout, true);
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
