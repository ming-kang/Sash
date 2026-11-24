import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "../error-utils.js";
import { protectedCorePath } from "../launcher/core-trust.js";
import {
  LINUX_HELPER_BIN_DIR,
  LINUX_HELPER_BINARY,
  LINUX_HELPER_MANIFEST,
  LINUX_HELPER_SOCKET,
  LINUX_HELPER_UNIT_FILE,
  LINUX_HELPER_WORK_DIR,
} from "../launcher/helper-linux.js";
import { coreSha256 } from "../launcher/index.js";
import { createIpcHelperClient } from "../launcher/ipc.js";
import type { HelperClient } from "../launcher/protocol.js";
import { currentPackageRoot } from "../package-info.js";
import type { SashLayout } from "../paths.js";
import { buildSanitizedEnv, findExecutableOnPath } from "../process.js";
import type { TunPlatform } from "../tun-service.js";

/**
 * The privileged install script, delivered on stdin to the elevated shell so
 * no user-writable file ever feeds a root process. Idempotent: re-running it
 * resynchronizes the protected helper binary and the protected Core after a
 * Sash upgrade or Core update.
 *
 * Arguments: <helper binary> <helper sha256> <core binary> <core sha256> <uid>
 */
export const LINUX_HELPER_INSTALL_SCRIPT = `set -euo pipefail

HELPER_SRC="$1"
HELPER_SHA="$2"
CORE_SRC="$3"
OWNER_UID="$4"

BIN="${LINUX_HELPER_BIN_DIR}"
WORK="${LINUX_HELPER_WORK_DIR}"
UNIT="${LINUX_HELPER_UNIT_FILE}"
SOCKET="${LINUX_HELPER_SOCKET}"
MANIFEST="${LINUX_HELPER_MANIFEST}"

if [ ! -f "$HELPER_SRC" ]; then echo "helper binary missing: $HELPER_SRC" >&2; exit 2; fi
if [ ! -f "$CORE_SRC" ]; then echo "core binary missing: $CORE_SRC" >&2; exit 2; fi
# The control socket is root-owned; the installing user is granted access
# with a file ACL so they cannot widen it themselves.
if ! command -v setfacl >/dev/null 2>&1; then
  echo "the acl package (setfacl) is required for the TUN helper socket" >&2
  exit 2
fi

# Protected-identity checks run BEFORE any fixed path is touched and
# before "systemctl stop" — a running unit's ExecStopPost executes the
# old helper as root, so the unit, the install directory and the old
# leaf must all prove their identity first. Checks are bitwise: no
# group/other write bit at all (a "-le 755" compare accepts 666/707).
protected_ok() {
  local f="$1" w
  # A symlink is never trusted — checked BEFORE -e so a dangling link
  # cannot pass as "absent".
  [ -L "$f" ] && return 1
  [ -e "$f" ] || return 1
  [ "$(stat -c '%u:%g' "$f")" = "0:0" ] || return 1
  # Any group/other write bit — or a failed probe — is not trusted.
  w="$(find "$f" -maxdepth 0 -perm /022 -print -quit 2>/dev/null)" || return 1
  [ -z "$w" ]
}

old_trusted=0
if { [ ! -e "$BIN" ] && [ ! -L "$BIN" ]; } && { [ ! -e "$UNIT" ] && [ ! -L "$UNIT" ]; }; then
  old_trusted=1   # fresh install — nothing foreign to execute
elif protected_ok "$BIN" && \
     { { [ ! -e "$BIN/sash-helper" ] && [ ! -L "$BIN/sash-helper" ]; } || { [ -f "$BIN/sash-helper" ] && protected_ok "$BIN/sash-helper"; }; } && \
     { { [ ! -e "$UNIT" ] && [ ! -L "$UNIT" ]; } || { [ -f "$UNIT" ] && protected_ok "$UNIT"; }; }; then
  old_trusted=1
fi

install -d -m 0700 -o root -g root "$WORK"

helper_changed=0
if [ "$(sha256sum "$BIN/sash-helper" 2>/dev/null | cut -d' ' -f1)" != "$HELPER_SHA" ]; then
  helper_changed=1
fi

if [ "$old_trusted" = "1" ]; then
  # Verified install: stopping runs ExecStopPost on bytes we just
  # proved are the protected old helper, then it cleans up explicitly.
  if systemctl is-active --quiet sash-helper.service 2>/dev/null; then
    systemctl stop sash-helper.service
  fi
  if [ -x "$BIN/sash-helper" ]; then
    "$BIN/sash-helper" --work-dir "$WORK" --cleanup
  fi
else
  # Unverified old install: remove the unit first so no ExecStopPost can
  # ever run unverified bytes, then kill the process directly and let
  # the verified staged binary (below) recover the journal.
  # Remove the unit first — with no unit file there is no ExecStopPost
  # for systemd to run. THEN the leftover process is killed directly.
  { [ -e "$UNIT" ] || [ -L "$UNIT" ]; } && rm -f "$UNIT"
  # The unit's loaded config is only gone once reload SUCCEEDS — while it
  # may still hold ExecStopPost, no stop/start may be issued. A failed
  # reload aborts the install entirely.
  if ! systemctl daemon-reload; then
    echo "systemctl daemon-reload failed; aborting install" >&2
    exit 5
  fi
  systemctl stop sash-helper.service 2>/dev/null || true
  systemctl reset-failed sash-helper.service 2>/dev/null || true
  # Kill only the processes in THIS service's cgroup/MainPID — never a
  # name-matched global pkill.
  main_pid="$(systemctl show -p MainPID --value sash-helper.service 2>/dev/null)"
  if [ -n "$main_pid" ] && [ "$main_pid" != "0" ]; then
    kill -9 "$main_pid" 2>/dev/null || true
  fi
  for p in $(cat /sys/fs/cgroup/system.slice/sash-helper.service/cgroup.procs 2>/dev/null); do
    kill -9 "$p" 2>/dev/null || true
  done
fi

install -d -m 0755 -o root -g root "$BIN"

# Stage the packaged helper inside the protected directory and re-verify
# the staged bytes before they are ever executed as root — the user-writable
# package path is never executed privileged.
install -m 0755 -o root -g root "$HELPER_SRC" "$BIN/.sash-helper.new"
staged_sha="$(sha256sum "$BIN/.sash-helper.new" | cut -d' ' -f1)"
if [ "$staged_sha" != "$HELPER_SHA" ]; then
  rm -f "$BIN/.sash-helper.new"
  echo "helper binary digest mismatch ($staged_sha != $HELPER_SHA)" >&2
  exit 4
fi

if [ "$old_trusted" = "0" ]; then
  # Trusted recovery entry for leftovers the unverified old helper left.
  "$BIN/.sash-helper.new" --work-dir "$WORK" --cleanup
fi

# The verified staged binary performs the consented install of the pair:
# it re-verifies its own digest plus the embedded paired-Core digest and
# publishes both into the protected directory atomically.
"$BIN/.sash-helper.new" --bin-dir "$BIN" --install-consent \
  "$BIN/.sash-helper.new" "$HELPER_SHA" "$CORE_SRC"
rm -f "$BIN/.sash-helper.new"

cat > "$UNIT" <<EOF
[Unit]
Description=Sash TUN privileged helper
After=network.target

[Service]
Type=simple
ExecStart=$BIN/sash-helper --socket $SOCKET --bin-dir $BIN --work-dir $WORK --uid $OWNER_UID
ExecStopPost=$BIN/sash-helper --work-dir $WORK --cleanup
Restart=always
RestartSec=1
RuntimeDirectory=sash-helper
KillMode=control-group
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$UNIT"

systemctl daemon-reload
systemctl enable sash-helper.service >/dev/null 2>&1 || true
if [ "$helper_changed" = "1" ] || ! systemctl is-active --quiet sash-helper.service; then
  systemctl restart sash-helper.service
fi

{
  echo "$UNIT"
  for file in "$BIN"/*; do [ -f "$file" ] && echo "$file"; done
  [ -f "$WORK/config.yaml" ] && echo "$WORK/config.yaml" || true
  [ -f "$WORK/network-journal.json" ] && echo "$WORK/network-journal.json" || true
} > "$MANIFEST"
chmod 0644 "$MANIFEST"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -S "$SOCKET" ] && exit 0
  sleep 0.3
done
if ! systemctl is-active --quiet sash-helper.service; then
  journalctl -u sash-helper.service -n 20 --no-pager >&2 || true
fi
echo "sash-helper did not create $SOCKET" >&2
exit 3
`;

/**
 * Uninstall stops the service first (a failed stop is an error, not a
 * warning), runs the journal cleanup, then removes only the paths the
 * install manifest recorded — never a recursive directory wipe.
 */
export const LINUX_HELPER_UNINSTALL_SCRIPT = `set -euo pipefail

BIN="${LINUX_HELPER_BIN_DIR}"
WORK="${LINUX_HELPER_WORK_DIR}"
UNIT="${LINUX_HELPER_UNIT_FILE}"
RUNTIME="$(dirname "${LINUX_HELPER_SOCKET}")"
MANIFEST="${LINUX_HELPER_MANIFEST}"

if systemctl cat sash-helper.service >/dev/null 2>&1; then
  systemctl disable --now sash-helper.service
fi
if systemctl is-active --quiet sash-helper.service 2>/dev/null; then
  echo "sash-helper.service is still active after stop" >&2
  exit 5
fi
if [ -x "$BIN/sash-helper" ]; then
  # A failed cleanup must abort the uninstall: deleting the helper would
  # leave recorded policy rules, routes or the device stranded.
  "$BIN/sash-helper" --work-dir "$WORK" --cleanup
fi
rm -f "$UNIT"
systemctl daemon-reload || true

if [ -f "$MANIFEST" ]; then
  while IFS= read -r file; do
    case "$file" in
      "$BIN"/*|"$WORK"/*|"$UNIT") rm -f -- "$file" ;;
    esac
  done < "$MANIFEST"
else
  # Fallback whitelist for installs made before the manifest existed.
  rm -f -- "$BIN/sash-helper" "$BIN/sash-helper.sha256" "$BIN"/mihomo.sha256 \
    "$BIN"/mihomo-* "$BIN"/bootstrap-manifest.json "$WORK/config.yaml" \
    "$WORK/network-journal.json"
fi
rm -rf -- "$WORK/.cleanup.lock" "$WORK"/.api-* 2>/dev/null || true
rmdir --ignore-fail-on-non-empty "$BIN" "$WORK" "$RUNTIME" 2>/dev/null || true
exit 0
`;

type Runner = (cmd: string, args: string[], timeoutMs?: number, input?: string) => Promise<string>;

const defaultRunner: Runner = (cmd, args, timeoutMs = 30_000, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      {
        encoding: "utf8",
        env: buildSanitizedEnv(),
        timeout: timeoutMs,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = `${stderr ?? ""}`.trim();
          reject(
            Object.assign(error, {
              message: detail ? `${error.message}: ${detail.slice(0, 400)}` : error.message,
            }),
          );
        } else {
          resolve(stdout ?? "");
        }
      },
    );
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });

export function packagedHelperBinary(packageRoot = currentPackageRoot()): string {
  const suffix = `${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
  return path.join(packageRoot, "dist", `sash-helper-${suffix}`);
}

/** The paired Core binary shipped in the same release artifact. */
export function packagedCoreBinary(packageRoot = currentPackageRoot()): string {
  const suffix = `${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
  return path.join(packageRoot, "dist", `sash-tun-core-${suffix}`);
}

function installerUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

/**
 * The elevated shell that receives the install script on stdin. pkexec is the
 * interactive path on a desktop; sudo -n is used only when the user opted in
 * with SASH_TUN_HELPER_AUTH=sudo — a refused pkexec prompt is never silently
 * retried through a second mechanism.
 */
function privilegeCommands(env: NodeJS.ProcessEnv): { cmd: string; args: string[] }[] {
  if (typeof process.geteuid === "function" && process.geteuid() === 0) {
    return [{ cmd: "/bin/bash", args: ["-s"] }];
  }
  const sudo = findExecutableOnPath("sudo", env);
  if (env.SASH_TUN_HELPER_AUTH === "sudo" && sudo) {
    return [{ cmd: sudo, args: ["-n", "/bin/bash", "-s"] }];
  }
  const pkexec = findExecutableOnPath("pkexec", env);
  return pkexec ? [{ cmd: pkexec, args: ["/bin/bash", "-s"] }] : [];
}

async function elevate(run: Runner, script: string, args: string[]): Promise<void> {
  const commands = privilegeCommands(buildSanitizedEnv());
  if (commands.length === 0) {
    throw new Error(
      "Installing the TUN helper requires pkexec (or sudo with SASH_TUN_HELPER_AUTH=sudo); neither was found",
    );
  }
  let lastError: unknown;
  for (const command of commands) {
    try {
      await run(command.cmd, [...command.args, "--", ...args], 120_000, script);
      return;
    } catch (error) {
      lastError = error;
      // A refused pkexec authentication must not fall back to sudo.
      break;
    }
  }
  throw new Error(
    `Privileged TUN helper setup failed: ${errorMessage(lastError)}. ` +
      "Approve the pkexec prompt, or rerun with SASH_TUN_HELPER_AUTH=sudo when your sudoers allows it.",
  );
}

async function statProtectedFile(file: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(file);
    return stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

export interface ProtectedPairPaths {
  unit: string;
  helper: string;
  manifest: string;
  core: string;
}

export interface InspectPairDeps {
  packageRoot?: string;
  statFile?: (file: string) => Promise<boolean>;
  versionOf?: (file: string) => Promise<string | null>;
}

/**
 * Inspect the protected install: missing service files mean "not
 * installed"; a present install whose helper doesn't run, whose helper
 * isn't the packaged one, or whose paired Core is missing/drifted means
 * consent again — a drifted install, distinct from an absent one.
 */
export async function inspectProtectedPair(paths: ProtectedPairPaths, deps: InspectPairDeps = {}) {
  const statFile = deps.statFile ?? statProtectedFile;
  const versionOf =
    deps.versionOf ??
    ((file: string) =>
      promisify(execFile)(file, ["--version"], { timeout: 5000 })
        .then(({ stdout }) => stdout.trim() || null)
        .catch(() => null));
  const [unit, helper, manifest, core] = await Promise.all([
    statFile(paths.unit),
    statFile(paths.helper),
    statFile(paths.manifest),
    statFile(paths.core),
  ]);
  const installed = unit && helper && manifest;
  if (!installed) return { installed: false, coreSynced: null };
  const helperVersion = await versionOf(paths.helper);
  const [expectedHelper, expectedCore, installedHelper, installedCore] = await Promise.all([
    coreSha256(packagedHelperBinary(deps.packageRoot)).catch(() => null),
    coreSha256(packagedCoreBinary(deps.packageRoot)).catch(() => null),
    coreSha256(paths.helper).catch(() => null),
    core ? coreSha256(paths.core).catch(() => null) : Promise.resolve(null),
  ]);
  const coreSynced =
    expectedCore !== null && installedCore !== null && installedCore === expectedCore;
  const paired = installedHelper !== null && installedHelper === expectedHelper;
  return {
    installed: true,
    coreSynced,
    helperVersion,
    needsReconsent: helperVersion === null || !paired || !coreSynced,
  };
}

export interface LinuxTunPlatformDeps {
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  statFile?: (file: string) => Promise<boolean>;
  versionOf?: (file: string) => Promise<string | null>;
}

/** The release manifest's recorded digest for this platform's packaged
 * helper — the integrity anchor the consented install re-verifies
 * against, so a pre-damaged or mismatched file is never mistaken for
 * the release artifact. */
async function packagedHelperDigest(packageRoot?: string): Promise<string> {
  const root = packageRoot ?? currentPackageRoot();
  const name = `sash-helper-${process.platform}-${process.arch}`;
  let manifest: {
    helpers?: { assets?: { name?: string; sha256?: string }[] };
  };
  try {
    manifest = JSON.parse(
      await fsp.readFile(path.join(root, "dist", "bootstrap-manifest.json"), "utf8"),
    );
  } catch (error) {
    throw new Error(`Could not read the release manifest: ${(error as Error).message}`);
  }
  const entry = manifest.helpers?.assets?.find((asset) => asset.name === name);
  if (!entry?.sha256) {
    throw new Error(`Release manifest has no digest for ${name}. Run npm run build first.`);
  }
  return entry.sha256;
}

async function installScriptArgs(_layout: SashLayout, packageRoot?: string): Promise<string[]> {
  const helper = packagedHelperBinary(packageRoot);
  const core = packagedCoreBinary(packageRoot);
  try {
    await fsp.access(helper, fs.constants.X_OK);
    await fsp.access(core, fs.constants.X_OK);
  } catch {
    throw new Error(
      `Packaged TUN binaries not found (${helper}, ${core}). Run npm run build first.`,
    );
  }
  // Anchor the expected digest on the release manifest, then prove the
  // packaged bytes match it before elevating — a pre-damaged or foreign
  // file at the package path fails here, not after privileged execution.
  const manifestSha = await packagedHelperDigest(packageRoot);
  const fileSha = await coreSha256(helper);
  if (fileSha !== manifestSha) {
    throw new Error(
      `Packaged helper does not match the release manifest (${fileSha} != ${manifestSha})`,
    );
  }
  return [helper, manifestSha, core, String(installerUid())];
}

const LINUX_PROTECTED_CORE = protectedCorePath(LINUX_HELPER_BIN_DIR);

export function linuxTunPlatform(deps: LinuxTunPlatformDeps = {}): TunPlatform {
  const run = deps.run ?? defaultRunner;
  return {
    supported: true,

    async inspect(_layout: SashLayout) {
      return inspectProtectedPair(
        {
          unit: LINUX_HELPER_UNIT_FILE,
          helper: LINUX_HELPER_BINARY,
          manifest: LINUX_HELPER_MANIFEST,
          core: LINUX_PROTECTED_CORE,
        },
        {
          packageRoot: deps.packageRoot,
          statFile: deps.statFile,
          versionOf: deps.versionOf,
        },
      );
    },

    async install(layout) {
      const args = await installScriptArgs(layout, deps.packageRoot);
      await elevate(run, LINUX_HELPER_INSTALL_SCRIPT, args);
      const state = await this.inspect(layout);
      if (!state.installed || state.needsReconsent) {
        throw new Error("TUN helper installation could not be verified");
      }
    },

    async uninstall(_layout) {
      await elevate(run, LINUX_HELPER_UNINSTALL_SCRIPT, []);
    },

    connect(_layout): HelperClient {
      try {
        fs.accessSync(LINUX_HELPER_SOCKET, fs.constants.R_OK | fs.constants.W_OK);
      } catch {
        throw new Error(
          `TUN helper service is not reachable at ${LINUX_HELPER_SOCKET}; check "systemctl status sash-helper"`,
        );
      }
      return createIpcHelperClient(LINUX_HELPER_SOCKET);
    },
  };
}
