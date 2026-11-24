import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { errorMessage } from "../error-utils.js";
import { createIpcHelperClient } from "../launcher/ipc.js";
import type { HelperClient } from "../launcher/protocol.js";
import { currentPackageRoot } from "../package-info.js";
import type { SashLayout } from "../paths.js";
import { runSanitizedCommandAsync } from "../process.js";
import type { TunPlatform } from "../tun-service.js";
import {
  HELPER_BIN,
  HELPER_LABEL,
  HELPER_LOG_ERR,
  HELPER_LOG_OUT,
  HELPER_META_FILE,
  HELPER_RUN_DIR,
  HELPER_SOCKET,
  LAUNCH_DAEMON_PLIST,
  PROTECTED_BIN_DIR,
  PROTECTED_WORK_DIR,
  SASH_SUPPORT_DIR,
} from "./macos-layout.js";

const OSASCRIPT = "/usr/bin/osascript";
const ELEVATE_TIMEOUT_MS = 300_000;

export function helperBinarySource(): string {
  return path.join(currentPackageRoot(), "dist", `sash-helper-darwin-${process.arch}`);
}

function packagedCoreSource(): string {
  return path.join(currentPackageRoot(), "dist", `sash-tun-core-darwin-${process.arch}`);
}

async function sha256File(file: string): Promise<string> {
  return createHash("sha256")
    .update(await fsp.readFile(file))
    .digest("hex");
}

/**
 * Endpoint identity: only a root-owned socket can be the helper's. A
 * user-writable directory could host a lookalike endpoint — every real
 * connection (probe, management, controller) verifies this before use.
 */
function verifyHelperSocket(endpoint: string): void {
  const sock = fs.lstatSync(endpoint);
  if (!sock.isSocket() || sock.uid !== 0) {
    throw new Error(`Refusing untrusted helper socket ${endpoint}`);
  }
}

async function probeHelper(timeoutMs = 2500): Promise<boolean> {
  try {
    const sock = await fsp.lstat(HELPER_SOCKET);
    if (!sock.isSocket() || sock.uid !== 0) return false;
    const client = createIpcHelperClient(HELPER_SOCKET, timeoutMs, verifyHelperSocket);
    await Promise.race([
      client.status(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("probe")), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function waitForHelper(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHelper()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`TUN helper did not come up on ${HELPER_SOCKET} — check ${HELPER_LOG_ERR}`);
}

function plistText(ownerUid: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>Label</key>
<string>${HELPER_LABEL}</string>
<key>ProgramArguments</key>
<array>
<string>${HELPER_BIN}</string>
<string>--bin</string>
<string>${PROTECTED_BIN_DIR}</string>
<string>--work</string>
<string>${PROTECTED_WORK_DIR}</string>
<string>--socket</string>
<string>${HELPER_SOCKET}</string>
<string>--owner-uid</string>
<string>${ownerUid}</string>
</array>
<key>RunAtLoad</key>
<true/>
<key>KeepAlive</key>
<true/>
<key>StandardOutPath</key>
<string>${HELPER_LOG_OUT}</string>
<key>StandardErrorPath</key>
<string>${HELPER_LOG_ERR}</string>
</dict>
</plist>
`;
}

function installScript(
  helperSrc: string,
  coreSrc: string,
  expectedHelperSha: string,
  ownerUid: number,
): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
set -eu
# Stop and PROVE any previous service is down before publishing anything.
if /bin/launchctl print "system/${HELPER_LABEL}" >/dev/null 2>&1; then
  /bin/launchctl bootout "system/${HELPER_LABEL}" || {
    echo "Could not stop the existing Sash helper service; install aborted" >&2
    exit 1
  }
  sleep 1
  if /bin/launchctl print "system/${HELPER_LABEL}" >/dev/null 2>&1; then
    echo "Existing Sash helper service is still running; install aborted" >&2
    exit 1
  fi
fi
# Rebuild the run directory from scratch: older installs handed it to the
# installing user, and neither chown/chmod nor an additive grant removes a
# pre-existing write ACL. A fresh root-owned dir has no inherited ACLs.
/bin/rm -rf ${q(HELPER_RUN_DIR)}
/bin/mkdir -p ${q(SASH_SUPPORT_DIR)} ${q(PROTECTED_BIN_DIR)} ${q(PROTECTED_WORK_DIR)} ${q(HELPER_RUN_DIR)}
/usr/sbin/chown root:wheel ${q(SASH_SUPPORT_DIR)} ${q(PROTECTED_BIN_DIR)} ${q(PROTECTED_WORK_DIR)} ${q(HELPER_RUN_DIR)}
/bin/chmod -N ${q(SASH_SUPPORT_DIR)} ${q(PROTECTED_BIN_DIR)} ${q(PROTECTED_WORK_DIR)} ${q(HELPER_RUN_DIR)}
/bin/chmod 755 ${q(SASH_SUPPORT_DIR)} ${q(PROTECTED_BIN_DIR)}
/bin/chmod 700 ${q(PROTECTED_WORK_DIR)} ${q(HELPER_RUN_DIR)}
owner_name=$(/usr/bin/id -un ${ownerUid})
# Narrow ACL: only the installing uid may traverse the socket directory.
/bin/chmod +a "user:\${owner_name} allow search" ${q(HELPER_RUN_DIR)}
STAGE=${q(SASH_SUPPORT_DIR)}/.staging.$$
trap '/bin/rm -rf "$STAGE"' EXIT
/bin/mkdir -m 700 "$STAGE"
# Never execute or publish user-writable bytes directly: copy both inputs
# into a root-owned staging dir, re-verify the helper digest the admin
# consented to on the staged bytes, and only then let the helper bind them
# atomically. The Core digest is the one embedded in the consented helper.
/bin/cp -f ${q(helperSrc)} "$STAGE/sash-helper"
/bin/cp -f ${q(coreSrc)} "$STAGE/mihomo"
/usr/sbin/chown root:wheel "$STAGE/sash-helper" "$STAGE/mihomo"
/bin/chmod 755 "$STAGE/sash-helper" "$STAGE/mihomo"
hsha=$(/usr/bin/shasum -a 256 "$STAGE/sash-helper" | /usr/bin/awk '{print $1}')
if [ -z ${q(expectedHelperSha)} ] || [ "$hsha" != ${q(expectedHelperSha)} ]; then
  echo "helper executable digest mismatch; refusing to install" >&2
  exit 1
fi
"$STAGE/sash-helper" --bin ${q(PROTECTED_BIN_DIR)} --install-consent \\
  --helper-src "$STAGE/sash-helper" --helper-sha "$hsha" \\
  --core-src "$STAGE/mihomo"
printf '%s' '{"ownerUid": ${ownerUid}}' > ${q(HELPER_META_FILE)}
/usr/sbin/chown root:wheel ${q(HELPER_META_FILE)}
/bin/chmod 644 ${q(HELPER_META_FILE)}
cat > ${q(LAUNCH_DAEMON_PLIST)} <<'PLIST'
${plistText(ownerUid)}PLIST
/usr/sbin/chown root:wheel ${q(LAUNCH_DAEMON_PLIST)}
/bin/chmod 644 ${q(LAUNCH_DAEMON_PLIST)}
/bin/launchctl bootstrap system ${q(LAUNCH_DAEMON_PLIST)}
/bin/launchctl kickstart -k "system/${HELPER_LABEL}" 2>/dev/null || true
`;
}

function uninstallScript(): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
set -u
# Stop the daemon and PROVE it is down before touching anything; a failed
# bootout must abort, never proceed to delete.
if /bin/launchctl print "system/${HELPER_LABEL}" >/dev/null 2>&1; then
  /bin/launchctl bootout "system/${HELPER_LABEL}" || {
    echo "Could not stop the Sash helper service; uninstall aborted" >&2
    exit 1
  }
fi
sleep 1
if /bin/launchctl print "system/${HELPER_LABEL}" >/dev/null 2>&1; then
  echo "Sash helper service is still running after bootout; uninstall aborted" >&2
  exit 1
fi
# Reap a leftover TUN session (routes/DNS) before removing evidence; a
# recovery failure keeps everything and aborts the uninstall.
if [ -x ${q(HELPER_BIN)} ]; then
  ${q(HELPER_BIN)} --work ${q(PROTECTED_WORK_DIR)} --recover || {
    echo "TUN session recovery failed; uninstall aborted" >&2
    exit 1
  }
fi
/bin/rm -f ${q(LAUNCH_DAEMON_PLIST)}
# Remove only installer-owned entries; rmdir fails if anything foreign was
# left in the support directory, which is exactly what we want.
/bin/rm -rf ${q(PROTECTED_BIN_DIR)} ${q(PROTECTED_WORK_DIR)} ${q(HELPER_RUN_DIR)}
/bin/rm -f ${q(HELPER_META_FILE)} ${q(HELPER_LOG_OUT)} ${q(HELPER_LOG_ERR)}
/bin/rmdir ${q(SASH_SUPPORT_DIR)} 2>/dev/null || true
`;
}

/** Install and uninstall share one elevation lane so they can never race on
 *  the same protected directory. */
let elevationLane: Promise<void> = Promise.resolve();
function serializeElevation(action: () => Promise<void>): Promise<void> {
  const next = elevationLane.then(action);
  elevationLane = next.catch(() => undefined);
  return next;
}

async function runElevatedScript(
  _layout: SashLayout,
  script: string,
  action: string,
): Promise<void> {
  // Never open an interactive administrator dialog from a test process; a
  // queued osascript prompt would block forever (and approving it could even
  // publish a staged fixture as the protected Core). Refuse up front instead
  // of silently hanging; callers turn this into needsResync / a visible error.
  if (process.env.VITEST || process.env.NODE_ENV === "test")
    throw new Error(`Elevated helper ${action} is unavailable inside tests`);
  // The script travels inside the osascript command (base64 → /bin/sh) so it
  // is never a user-writable file that could be swapped before root runs it.
  const encoded = Buffer.from(script, "utf8").toString("base64");
  try {
    await runSanitizedCommandAsync(
      OSASCRIPT,
      [
        "-e",
        `do shell script "printf %s '${encoded}' | /usr/bin/base64 -D | /bin/sh" with prompt "Sash wants to ${action} its TUN helper (root service)." with administrator privileges`,
      ],
      { timeoutMs: ELEVATE_TIMEOUT_MS },
    );
  } catch (error) {
    const message = errorMessage(error);
    if (/cancel/i.test(message)) {
      throw new Error(
        `macOS administrator authorization was cancelled — TUN helper ${action} aborted`,
      );
    }
    throw new Error(`Elevated helper ${action} failed: ${message}`);
  }
}

const PROTECTED_CORE_BIN = path.join(PROTECTED_BIN_DIR, "mihomo");

/** The installed helper's embedded version (`--version`, side-effect free). */
async function protectedHelperVersion(): Promise<string | null> {
  return await runSanitizedCommandAsync(HELPER_BIN, ["--version"], { timeoutMs: 3000 })
    .then((out) => out.trim() || null)
    .catch(() => null);
}

export function macosTunPlatform(): TunPlatform {
  return {
    supported: true,

    async inspect(_layout) {
      const [plist, helper, installed, helperVersion, coreSynced] = await Promise.all([
        fsp
          .stat(LAUNCH_DAEMON_PLIST)
          .then((s) => s.isFile())
          .catch(() => false),
        fsp
          .stat(HELPER_BIN)
          .then((s) => s.isFile())
          .catch(() => false),
        probeHelper(),
        protectedHelperVersion(),
        // The protected Core is paired when its digest matches the Core this
        // package ships; an unreadable file reports "unknown", not "drifted".
        Promise.all([
          sha256File(PROTECTED_CORE_BIN).catch(() => null),
          sha256File(packagedCoreSource()).catch(() => null),
        ]).then(([installedCore, expectedCore]) =>
          installedCore !== null && expectedCore !== null
            ? installedCore === expectedCore
            : null,
        ),
      ]);
      if (!plist || !helper) return { installed: false };
      // Pairing drift (helper version vs package version) is reported by the
      // shared layer via helperVersion.
      return { installed, helperVersion, coreSynced };
    },

    async install(layout) {
      const helperSrc = helperBinarySource();
      const coreSrc = packagedCoreSource();
      for (const src of [helperSrc, coreSrc]) {
        if (
          !(await fsp
            .stat(src)
            .then((s) => s.isFile())
            .catch(() => false))
        ) {
          throw new Error(
            `TUN artifact is missing at ${src} — build them first with: npm run build:helper && npm run build`,
          );
        }
      }
      const ownerUid = process.getuid?.() ?? os.userInfo().uid;
      const expectedHelperSha = await sha256File(helperSrc);
      await serializeElevation(() =>
        runElevatedScript(
          layout,
          installScript(helperSrc, coreSrc, expectedHelperSha, ownerUid),
          "install",
        ),
      );
      await waitForHelper();
    },

    async uninstall(layout) {
      await serializeElevation(() => runElevatedScript(layout, uninstallScript(), "uninstall"));
    },

    connect(): HelperClient {
      return createIpcHelperClient(HELPER_SOCKET, 10_000, verifyHelperSocket);
    },
  };
}
