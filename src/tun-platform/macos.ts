import fs from "node:fs/promises";
import os from "node:os";
import { errorMessage } from "../error-utils.js";
import type { SashLayout } from "../paths.js";
import { runSanitizedCommandAsync } from "../process.js";
import type { TunPlatform, TunPrivilege } from "../tun-service.js";
import { requireCoreFile, shellQuote } from "./shared.js";

const OSASCRIPT = "/usr/bin/osascript";
export const MACOS_TUN_GUARD_ANCHOR = "dev.astralyn.sash";
export const MACOS_PF_ANCHOR_LINE = `anchor "${MACOS_TUN_GUARD_ANCHOR}"`;

/** Sash 0.7.0 installed a LaunchDaemon helper; installing or removing the grant retires it. */
const LEGACY_CLEANUP = `
legacy=dev.astralyn.sash.helper
if /bin/launchctl print "system/$legacy" >/dev/null 2>&1; then
  /bin/launchctl bootout "system/$legacy" || true
fi
/bin/rm -f "/Library/LaunchDaemons/$legacy.plist"
/bin/rm -rf "/Library/Application Support/Sash"
`;

export const MACOS_TUN_GUARD_SCRIPT = `#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

anchor=${MACOS_TUN_GUARD_ANCHOR}
anchor_file=/etc/pf.anchors/$anchor
state_dir=/var/run/sash-tun-guard
token_file=$state_dir/pf.token

usage() {
  echo "usage: sash-tun-guard setup [device] | teardown | status" >&2
  exit 2
}

if [ $# -lt 1 ]; then
  usage
fi
verb=$1
case $verb in
  setup)
    if [ $# -gt 2 ]; then
      usage
    fi
    ;;
  teardown | status)
    if [ $# -ne 1 ]; then
      usage
    fi
    ;;
  *)
    usage
    ;;
esac

exec 9>/var/run/sash-tun-guard.lock
if ! /usr/bin/lockf -s -t 30 9; then
  echo "sash-tun-guard: timed out waiting for the guard lock" >&2
  exit 1
fi

pf_enabled() {
  /sbin/pfctl -s info 2>/dev/null | /usr/bin/grep -E '^Status:[[:space:]]+Enabled' >/dev/null 2>&1
}

read_saved_token() {
  token=$(/bin/cat "$token_file" 2>/dev/null || true)
  case $token in
    "" | *[!0-9]*)
      token=""
      ;;
  esac
  printf '%s' "$token"
}

release_pf_reference() {
  token=$(read_saved_token)
  if [ -n "$token" ]; then
    /sbin/pfctl -X "$token" >/dev/null 2>&1 || true
  fi
  /bin/rm -f "$token_file" 2>/dev/null || true
  /bin/rmdir "$state_dir" 2>/dev/null || true
}

ensure_pf_reference() {
  if pf_enabled && [ -n "$(read_saved_token)" ]; then
    return 0
  fi

  old_token=$(read_saved_token)
  if [ -n "$old_token" ]; then
    /sbin/pfctl -X "$old_token" >/dev/null 2>&1 || true
    /bin/rm -f "$token_file" 2>/dev/null || true
  fi

  if ! enable_output=$(/sbin/pfctl -E 2>&1); then
    case $enable_output in
      *"pf already enabled"*)
        return 0
        ;;
    esac
    printf '%s\\n' "$enable_output" >&2
    echo "sash-tun-guard: could not enable pf" >&2
    exit 1
  fi

  token=$(printf '%s\\n' "$enable_output" | /usr/bin/sed -n 's/^Token[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\)[[:space:]]*$/\\1/p' | /usr/bin/head -n 1)
  if [ -z "$token" ]; then
    printf '%s\\n' "$enable_output" >&2
    echo "sash-tun-guard: pfctl did not return an enable token" >&2
    exit 1
  fi

  /bin/mkdir -p "$state_dir"
  /bin/chmod 0700 "$state_dir"
  token_tmp="$state_dir/.pf.token.$$"
  printf '%s\\n' "$token" > "$token_tmp"
  /bin/chmod 0600 "$token_tmp"
  /usr/sbin/chown root:wheel "$token_tmp" 2>/dev/null || true
  /bin/mv -f "$token_tmp" "$token_file"
}

if [ "$verb" = "status" ]; then
  main=unknown
  if main_rules=$(/sbin/pfctl -s rules 2>/dev/null); then
    if printf '%s\\n' "$main_rules" | /usr/bin/grep -F '${MACOS_PF_ANCHOR_LINE}' >/dev/null 2>&1; then
      main=attached
    else
      main=detached
    fi
  fi

  anchor_state=not-loaded
  rules=0
  if anchor_rules=$(/sbin/pfctl -a "$anchor" -s rules 2>/dev/null); then
    rules=$(printf '%s\\n' "$anchor_rules" | /usr/bin/awk 'NF { count += 1 } END { print count + 0 }')
    if [ "$rules" -gt 0 ]; then
      anchor_state=loaded
    fi
  fi

  pf=unknown
  if pf_enabled; then
    pf=enabled
  elif /sbin/pfctl -s info 2>/dev/null | /usr/bin/grep -E '^Status:[[:space:]]+Disabled' >/dev/null 2>&1; then
    pf=disabled
  fi

  reference=not-held
  if pf_enabled && [ -n "$(read_saved_token)" ]; then
    reference=held
  fi

  printf 'main=%s\\nanchor=%s\\nrules=%s\\npf=%s\\npf-reference=%s\\n' "$main" "$anchor_state" "$rules" "$pf" "$reference"
  exit 0
fi

if [ "$verb" = "teardown" ]; then
  flush_error=""
  if ! flush_output=$(/sbin/pfctl -a "$anchor" -F rules 2>&1); then
    case $flush_output in
      *"Anchor or Ruleset does not exist"*)
        ;;
      *)
        flush_error=$flush_output
        ;;
    esac
  fi
  release_pf_reference
  if [ -n "$flush_error" ]; then
    printf '%s\\n' "$flush_error" >&2
    echo "sash-tun-guard: could not clear the pf anchor" >&2
    exit 1
  fi
  echo "sash-tun-guard: pf anchor $anchor cleared" >&2
  exit 0
fi

interfaces=$(/sbin/ifconfig -l 2>/dev/null) || {
  echo "sash-tun-guard: could not enumerate network interfaces" >&2
  exit 1
}
physical=""
for interface in $interfaces; do
  case $interface in
    en*)
      physical="$physical $interface"
      ;;
  esac
done
if [ -z "$physical" ]; then
  echo "sash-tun-guard: no en* network interface is present" >&2
  exit 1
fi

/bin/mkdir -p /etc/pf.anchors
rules_tmp=/etc/pf.anchors/.sash-tun-guard.$$
trap '/bin/rm -f "$rules_tmp" 2>/dev/null || true' EXIT
{
  /bin/cat <<'SASH_PF_RULES_EOF'
# Interfaces are enumerated at setup time; a hot-plugged interface is covered by the next setup.
# The exemption set is deliberately minimal: DNS and NTP have no Internet exemption, and local
# resolvers, DHCP and multicast are already covered by the LAN, link-local and multicast ranges.
pass out quick on lo0 all no state
pass out quick proto tcp all user = root no state
pass out quick proto udp all user = root no state
pass out quick inet from any to { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 224.0.0.0/4, 255.255.255.255/32 } no state
pass out quick inet6 from any to { fc00::/7, fe80::/10, ff00::/8 } no state
SASH_PF_RULES_EOF
  for interface in $physical; do
    printf 'block return out quick on %s inet all\\n' "$interface"
    printf 'block return out quick on %s inet6 all\\n' "$interface"
  done
} > "$rules_tmp"
/bin/chmod 0644 "$rules_tmp"
/usr/sbin/chown root:wheel "$rules_tmp"

if ! /sbin/pfctl -a "$anchor" -n -f "$rules_tmp" >/dev/null 2>&1; then
  /sbin/pfctl -a "$anchor" -n -f "$rules_tmp" >&2 || true
  echo "sash-tun-guard: generated pf rules did not parse" >&2
  exit 1
fi
/bin/mv -f "$rules_tmp" "$anchor_file"
rules_tmp=

if ! load_output=$(/sbin/pfctl -a "$anchor" -f "$anchor_file" 2>&1); then
  printf '%s\\n' "$load_output" >&2
  echo "sash-tun-guard: could not load the pf anchor" >&2
  exit 1
fi
ensure_pf_reference

echo "sash-tun-guard: pf anchor $anchor loaded" >&2
exit 0
`;

export const PF_CONF_EDIT_FUNCTIONS = `
sash_pf_anchor_present() {
  /usr/bin/grep -Fqx '${MACOS_PF_ANCHOR_LINE}' "$1" 2>/dev/null
}

sash_insert_pf_anchor() {
  pfconf=$1
  backup=$2
  pfctl=$3
  if [ ! -f "$pfconf" ] || [ -L "$pfconf" ]; then
    echo "sash: $pfconf is missing or is not a regular file" >&2
    return 1
  fi
  if sash_pf_anchor_present "$pfconf"; then
    return 0
  fi
  if ! "$pfctl" -n -f "$pfconf" >/dev/null 2>&1; then
    echo "sash: $pfconf does not parse; refusing to edit it" >&2
    return 1
  fi
  if [ ! -e "$backup" ]; then
    if ! /bin/cp -p "$pfconf" "$backup"; then
      echo "sash: could not back up $pfconf to $backup" >&2
      return 1
    fi
  fi
  pfdir=\${pfconf%/*}
  if [ "$pfdir" = "$pfconf" ]; then
    pfdir=.
  fi
  tmp="$pfdir/.pf.conf.sash.$$"
  if ! /bin/cp -p "$pfconf" "$tmp"; then
    echo "sash: could not stage a replacement for $pfconf" >&2
    return 1
  fi
  printf '\\n%s\\n' '${MACOS_PF_ANCHOR_LINE}' >> "$tmp"
  if ! "$pfctl" -n -f "$tmp" >/dev/null 2>&1; then
    /bin/rm -f "$tmp"
    echo "sash: the edited $pfconf does not parse; leaving it unchanged" >&2
    return 1
  fi
  if ! /bin/mv -f "$tmp" "$pfconf"; then
    /bin/rm -f "$tmp"
    echo "sash: could not replace $pfconf" >&2
    return 1
  fi
  return 0
}

sash_pf_anchor_is_active() {
  "$1" -s rules 2>/dev/null | /usr/bin/grep -F '${MACOS_PF_ANCHOR_LINE}' >/dev/null 2>&1
}

sash_activate_pf_anchor() {
  pfconf=$1
  pfctl=$2
  if sash_pf_anchor_is_active "$pfctl"; then
    return 0
  fi
  if ! "$pfctl" -f "$pfconf" >/dev/null 2>&1; then
    echo "sash: could not reload $pfconf to attach the Sash pf anchor" >&2
    return 1
  fi
  if ! sash_pf_anchor_is_active "$pfctl"; then
    echo "sash: $pfconf was reloaded but the Sash pf anchor is not attached" >&2
    return 1
  fi
  return 0
}

sash_remove_pf_anchor() {
  pfconf=$1
  if [ ! -f "$pfconf" ] || [ -L "$pfconf" ]; then
    echo "sash: $pfconf is missing or is not a regular file" >&2
    return 1
  fi
  if ! sash_pf_anchor_present "$pfconf"; then
    return 0
  fi
  pfdir=\${pfconf%/*}
  if [ "$pfdir" = "$pfconf" ]; then
    pfdir=.
  fi
  base="$pfdir/.pf.conf.sash.base.$$"
  filtered="$pfdir/.pf.conf.sash.filtered.$$"
  if ! /bin/cp -p "$pfconf" "$base"; then
    echo "sash: could not stage a replacement for $pfconf" >&2
    return 1
  fi
  if ! /usr/bin/awk -v line='${MACOS_PF_ANCHOR_LINE}' '$0 != line' "$pfconf" > "$filtered"; then
    /bin/rm -f "$base" "$filtered"
    echo "sash: could not edit $pfconf" >&2
    return 1
  fi
  if ! /bin/cat "$filtered" > "$base"; then
    /bin/rm -f "$base" "$filtered"
    echo "sash: could not edit $pfconf" >&2
    return 1
  fi
  /bin/rm -f "$filtered"
  if ! /bin/mv -f "$base" "$pfconf"; then
    /bin/rm -f "$base"
    echo "sash: could not replace $pfconf" >&2
    return 1
  fi
  return 0
}
`;

const GUARD_INSTALL = `
guard=/usr/local/libexec/sash-tun-guard
guard_tmp=/usr/local/libexec/.sash-tun-guard.new.$$
if ! (
  /bin/mkdir -p /usr/local/libexec &&
  /bin/cat > "$guard_tmp" <<'SASH_TUN_GUARD_EOF' &&
${MACOS_TUN_GUARD_SCRIPT}SASH_TUN_GUARD_EOF
  /bin/chmod 0755 "$guard_tmp" &&
  /usr/sbin/chown root:wheel "$guard_tmp" &&
  /bin/mv -f "$guard_tmp" "$guard"
); then
  /bin/rm -f "$guard_tmp" 2>/dev/null || true
  echo "sash: could not install $guard" >&2
  exit 1
fi

case $user in
  root)
    ;;
  "" | *[!a-zA-Z0-9._-]*)
    echo "sash: the user name $user cannot be represented safely in sudoers" >&2
    exit 1
    ;;
  *)
    if [ \${#user} -gt 32 ]; then
      echo "sash: the user name $user is too long for the sudoers rule" >&2
      exit 1
    fi
    sudoers_tmp=/etc/sudoers.d/.sash-tun-guard.$$
    if ! (
      /bin/mkdir -p /etc/sudoers.d &&
      printf '%s\\n' "$user ALL=(root) NOPASSWD: $guard" > "$sudoers_tmp" &&
      /bin/chmod 0440 "$sudoers_tmp" &&
      /usr/sbin/chown root:wheel "$sudoers_tmp" &&
      /usr/sbin/visudo -cf "$sudoers_tmp" >/dev/null 2>&1 &&
      /bin/mv -f "$sudoers_tmp" /etc/sudoers.d/sash-tun-guard
    ); then
      /bin/rm -f "$sudoers_tmp" 2>/dev/null || true
      echo "sash: could not install the sudoers rule for $guard" >&2
      exit 1
    fi
    ;;
esac

${PF_CONF_EDIT_FUNCTIONS}
if ! sash_insert_pf_anchor /etc/pf.conf /etc/pf.conf.sash-backup /sbin/pfctl; then
  exit 1
fi
if ! sash_activate_pf_anchor /etc/pf.conf /sbin/pfctl; then
  exit 1
fi
`;

const GUARD_REMOVE = `
if [ -x /usr/local/libexec/sash-tun-guard ]; then
  /usr/local/libexec/sash-tun-guard teardown >/dev/null 2>&1 || true
fi
/sbin/pfctl -a ${MACOS_TUN_GUARD_ANCHOR} -F rules >/dev/null 2>&1 || true
/bin/rm -f /etc/pf.anchors/${MACOS_TUN_GUARD_ANCHOR}
/bin/rm -f /etc/sudoers.d/sash-tun-guard
/bin/rm -f /usr/local/libexec/sash-tun-guard
/bin/rm -f /var/run/sash-tun-guard.lock
/bin/rm -f /var/run/sash-tun-guard/pf.token
/bin/rmdir /var/run/sash-tun-guard 2>/dev/null || true
${PF_CONF_EDIT_FUNCTIONS}
if ! sash_remove_pf_anchor /etc/pf.conf; then
  echo "warning: could not remove the Sash anchor line from /etc/pf.conf" >&2
fi
`;

/**
 * Make the managed Core setuid root, executable by the installing user's
 * group — the approach macOS proxy clients have long used for TUN. Replacing
 * the file (a Core update) drops the grant with it.
 */
export function grantScript(core: string, user: string): string {
  return `set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
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
${LEGACY_CLEANUP}${GUARD_INSTALL}`;
}

/**
 * Return the Core to the user. A root Core leaves root-owned files in the
 * data folder (cache.db, geodata, provider caches); they go back too, so an
 * ordinary Core can keep updating them.
 */
export function revokeScript(core: string, home: string, user: string): string {
  return `set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
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
${GUARD_REMOVE}${LEGACY_CLEANUP}`;
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
