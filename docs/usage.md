# Sash User & Operations Guide

Sash is a lightweight command-line companion and web dashboard for managing a rule-based network core.

---

## 1. Quick Start

```sh
sash start
sash web        # open the dashboard: download a subscription, pick nodes, toggle the system proxy
sash status
```

Profiles, the system proxy and runtime settings are managed from the web dashboard; the CLI covers lifecycle, logs, upgrades and Windows service administration. There is no `sash tun` command.

---

## 2. CLI Command Reference

### Lifecycle Management

| Command | Description |
| :--- | :--- |
| `sash start` | Install missing components, ensure the background daemon is running, then reconcile/start the core. It is safe to repeat. |
| `sash stop` | Restore the pre-Sash system proxy, stop the Core and shut down the daemon; exits with an error if safe shutdown cannot be verified. |
| `sash restart` | Restart the whole runtime: the daemon exits through its maintenance boundary and a fresh daemon starts the core. |
| `sash status [--json]` | Show daemon/core state, active profile, endpoints and system proxy state; incomplete observations exit with code 2. |
| `sash logs [-n N] [-f] [--errors] [--daemon]` | View core or daemon logs; `-f` follows new output. |

### Windows Service Administration

| Command | Description |
| :--- | :--- |
| `sash service install [--core-version V] [--helper PATH]` | Explicit same-user Administrator install/repair of the optional Windows helper and approved Core. |
| `sash service status [--json]` | Inspect service availability without starting it or the Core. |
| `sash service uninstall` | Same-user Administrator removal after safe daemon/proxy/Core shutdown. |

`--helper` accepts an explicitly selected source-built helper; it is not `--helper-path`. Without it, installation first looks for a matching installed or source-built helper (`.native/windows-amd64` or `.native/windows-arm64`), then fetches the matching official Sash release `.exe` asset with its mandatory GitHub SHA-256 digest. See [setup](#4-tun-mode).

### Status JSON and exit codes

`sash status --json` emits the versioned `schemaVersion: 1` contract below. Unobservable runtime values are `null`; they are never changed to `false` merely because a query timed out.

```json
{
  "schemaVersion": 1,
  "complete": true,
  "healthy": true,
  "queryError": null,
  "daemon": {
    "state": "healthy",
    "running": true,
    "healthy": true,
    "pid": 1234,
    "port": 19090
  },
  "core": {
    "running": true,
    "healthy": true,
    "pid": 1235,
    "version": "v1.19.30",
    "installedVersion": "v1.19.30"
  },
  "systemProxy": {
    "desired": false,
    "daemonApplied": false,
    "osObserved": {
      "supported": true,
      "enabled": false,
      "server": null,
      "details": null
    }
  },
  "uiInstalled": true,
  "endpoints": {
    "mixedProxy": "127.0.0.1:7890",
    "controller": "127.0.0.1:9090",
    "daemonApi": "http://127.0.0.1:19090",
    "dashboard": "http://127.0.0.1:19090/ui/"
  },
  "activeProfile": null,
  "tun": {
    "desired": false,
    "active": false
  },
  "paths": {
    "root": "<data directory>",
    "config": "<data directory>/config.yaml"
  }
}
```

`healthy` is the observed daemon/Core controller health and is `null` when daemon runtime status cannot be queried. `complete` covers observability of all contract fields; `queryError` explains an incomplete result. Exit codes are stable:

| Exit code | Meaning |
| :--- | :--- |
| `0` | The status is complete, including a known stopped state. |
| `2` | Status output was produced, but daemon/Core/OS state could not be fully observed. |
| `1` | The command itself failed, for example because local state is corrupt. |

Text output follows the same distinction: an unresponsive daemon is reported as unavailable, never with a success marker. `sash status` prints separate daemon, desired, daemon-applied and OS-observed proxy lines and uses exit code 2 when the daemon is alive but unresponsive.

### Log following

`logs -f` behaves like a bounded `tail -F`: it waits when the selected file or log directory does not exist yet, follows appended bytes, restarts at byte zero after truncation or file replacement/rotation, and releases its watcher/timer on SIGINT or SIGTERM. `-n` accepts only canonical positive decimal integers such as `1` or `100`; zero, signs, whitespace, fractions, numeric prefixes and values above JavaScript's safe-integer limit are rejected.

Sash does not blindly turn off an existing proxy. It stores a private ownership journal before takeover and restores only while managed OS values still match the original/Sash transition. If another application changes those values, Sash refuses to overwrite them. Windows and macOS include manual and automatic proxy state; Linux system-proxy automation currently requires GNOME `gsettings`.

### Web Dashboard

| Command | Description |
| :--- | :--- |
| `sash web` | Open `http://127.0.0.1:19090/ui/`. |
| `sash web --no-open` | Print the dashboard URL without opening a browser. |

### Profiles

Profiles are managed from the WebUI Profiles page: download from a subscription URL, import a local YAML file, update one or all profiles, rename, edit content, switch the active profile and delete. Remote profiles use the update interval advertised by the provider, defaulting to 24 hours. The daemon checks for due updates every 15 minutes.

### Settings

Runtime settings (`mixedPort`, `tun`, `allowLan`, `systemProxy`) are managed from the WebUI Settings page (including TUN), and the entire `sash.json` can be edited as JSON from the same page ("Edit settings file"); invalid documents are rejected without touching the disk. `daemonSecret` changes apply immediately; `daemonPort` changes are saved but require a manual `sash restart` to rebind the listener.

### Maintenance & Upgrades

| Command | Description |
| :--- | :--- |
| `sash update [--version V] [--force]` | Download and validate a replacement core, then swap it in transactionally. |
| `sash upgrade [--version V]` | Upgrade the Sash package through npm; requires `sashd` to be stopped first. |
| `sash version` | Print the Sash package version. |

In direct mode, Core updates download and validate before shutdown, then use an authenticated maintenance request that atomically snapshots whether Core was running while restoring proxy state and stopping `sashd`. After daemon exit, a durable update journal records the previous/target install records before the executable swap. A previously running Core is health-checked immediately; when Core was stopped, `<core>.bak` and the journal remain until the next managed `sash start` passes controller health/version checks. A failed first start restores the previous binary and install record before attempting to restart it. Downloads require official GitHub SHA-256 asset metadata; mirrors are accepted only as transports for bytes matching that digest, and all mirror/redirect/body attempts share a bounded absolute deadline. Archives are capped at 128 MiB, Windows ZIPs must contain the expected upstream Core executable basename, staged binaries must report the exact requested version, and the staged Core validates the freshly generated active configuration before publication.

`sash upgrade --version` accepts only a strict npm semver such as `1.2.3` (without a `v` prefix) or a safe dist-tag such as `latest`/`next`. Package specs, paths, ranges and control characters are rejected.

---

## 3. Configuration Reference (`sash.json`)

| Key | Default | Description |
| :--- | :--- | :--- |
| `schemaVersion` | `1` | On-disk settings schema; managed by Sash. |
| `mixedPort` | `7890` | Local HTTP/SOCKS5 mixed inbound port. Change it from the dashboard. |
| `controller` | `127.0.0.1:9090` | Internal controller listen address; only loopback hosts are accepted. |
| `daemonPort` | `19090` | Daemon API and WebUI port. |
| `secret` | *(random)* | Internal controller secret. It is never returned by the public status API. |
| `daemonSecret` | *(random)* | CLI bearer secret for state-changing daemon requests. |
| `systemProxy` | `false` | Desired OS-level system proxy state. |
| `tun` | `false` | Desired TUN inbound; Windows requires service mode, other platforms require manual elevation. |
| `allowLan` | `false` | Accept proxy traffic from other devices. |

A legacy `subscriptionUrl` key is migrated once into `profiles/index.json` and then removed. It has priority over legacy `config.yaml` import. If no `profiles/index.json` has ever been created, startup/offline initialization may import an existing `config.yaml` once as the active local profile named `Imported config` (`url: ""`, updates disabled). A present empty index opts out. To avoid importing Sash's own generated default, the file must be valid core-format YAML and contain non-default routing content after managed keys are removed: nonempty proxies/providers, or nonempty rules/groups differing from the DIRECT-only default. The runtime `config.yaml` is kept unchanged during import; later profile application re-renders and validates it. Invalid YAML/config fails closed without overwriting the file.

Installed core version metadata lives in `state/install.json`, not in `sash.json`.

Malformed, future-version or unknown-field `sash.json` documents and malformed `profiles/index.json` files are rejected without being overwritten. Secrets cannot be blank or contain control characters, the controller must remain loopback-only, and the mixed, controller and daemon ports must all differ. Repair or move a damaged file explicitly instead of relying on silent defaults.

Core-related settings/config changes are validated before publication and compensated on restart failure. A multi-key settings request is not wholly atomic: Core/settings changes can commit before a separate system-proxy transaction fails. Turning the system proxy off persists desired off before OS cleanup. An explicit `systemProxy: false` retries release even when desired state is already false; it never authorizes changing an unrelated proxy. If cleanup fails, toggle off again after resolving the OS error.

---

## 4. TUN Mode

### Windows: install the service, keep the daemon unelevated

Windows TUN is service-only. An elevated direct daemon is not a fallback. One Windows user SID and one canonical absolute `SASH_HOME` are enrolled per machine; another user/root fails closed rather than taking over.

For an npm installation, initialize the user root in an **ordinary** PowerShell first:

```powershell
npm install -g @astralyn/sash
# If customized, use this exact SASH_HOME in both shells.
# $env:SASH_HOME = 'C:\your\custom\Sash'
sash status
```

Install/uninstall require an existing initialized user root; they never create it as Administrator or change its owner/ACLs.

Then, in an Administrator PowerShell opened as the **same Windows user**:

```powershell
# If customized, set the exact same root used by the ordinary shell.
# $env:SASH_HOME = 'C:\your\custom\Sash'
sash service install
sash service status
```

For a source checkout, build in an ordinary PowerShell with Go 1.26.7:

```powershell
npm run build
npm run build:service -- --arch amd64 # use arm64 on Windows ARM64
npm link
sash status # initialize/inspect the same user's data root
```

Then, from the same user's Administrator PowerShell, replace the example checkout path:

```powershell
sash service install --helper 'C:\path\to\Sash\.native\windows-amd64\sash-service.exe'
# On ARM64 use .native\windows-arm64\sash-service.exe instead.
```

`npm run build` remains TypeScript/UI-only. No service is installed by a build.

The installer checks native privileges before maintenance, stages trusted bytes into administrator/SYSTEM-protected storage and uses a protected sibling installer copy (`stage-maintenance`) so replacing the running helper cannot self-lock. Install/repair first stops the existing daemon and restores its owned system proxy. Interrupted first installs use administrative `repair-status` and verified protected journals; foreign enrollment or uncertain runtime evidence still blocks repair. It returns without an elevated daemon respawn.

Return to an **ordinary** PowerShell, preserving the same `SASH_HOME`:

```powershell
sash start
sash web
```

Enable TUN in the dashboard only when the service is **ready** and Core is healthy. The service is registered with SCM and can remain running idle: it does not automatically start Core or TUN at boot. `sash stop` stops the user runtime/Core and restores proxy ownership, not the idle SCM service. `sash restart` replaces the user daemon without changing its privilege level.

Installed code, policy and private Core runtime data live under the Windows known Program Files directory, normally `C:\Program Files\SashService`, **not ProgramData**. Profiles/settings and provider/geodata download caches stay in the enrolled user root. Never copy arbitrary executables into protected storage or weaken its ACLs.

### Service status, updates and removal

`sash service status` and `GET /sash/service` expose `supported` plus `not-installed`, `ready`, `unavailable`, `incompatible` or `root-mismatch`, with optional helper/Core versions and a diagnostic message. Ready describes the service, not a running Core/TUN device. Unsupported platforms report `supported: false`. Installed-but-unavailable, incompatible or mismatched services never silently select direct mode.

A responsive daemon can report public `core.running: null` with `core.queryError`: the service-backed Core is **unobserved**, not stopped, and this does not mean the daemon is offline. Resolve the service issue and re-query before lifecycle operations; Sash preserves uncertain ownership and attempts to release its user proxy safely.

In service mode, `sash update [--version V]` requires an explicit same-user Administrator shell. It uses trusted protected staging and retains the prior approved binary/state until a managed start passes health checks, with rollback on failure. It does not use a direct child supervisor to verify the privileged installation. Return to the ordinary shell for `sash start` after maintenance. Package updates remain separate (`sash upgrade`, daemon stopped).

To remove the service, use an Administrator shell with the enrolled root and run `sash service uninstall`. Desired `tun` is preserved. Prefer turning TUN off in the dashboard **before** uninstall if returning to direct mode. If removed while desired TUN remains on, the next direct start fails with service-required guidance; return to an ordinary PowerShell with the same `SASH_HOME` and run `sash web`. If Core startup fails but the daemon is healthy, it opens the recovery dashboard with a warning. Turn TUN off there, then run `sash start` for direct mode. Service reinstallation is not required for this recovery. If the daemon itself remains offline or unhealthy, resolve that error first; an offline HTTP API cannot clear intent.

### macOS/Linux: manual elevation

These platforms retain direct mode only. Note the data root from `sash status` and pass it explicitly (`sudo` can change the default home):

```sh
sudo env SASH_HOME='<data root>' "$(command -v sash)" restart
# Enable TUN from the dashboard after the elevated daemon is responsive.
sudo env SASH_HOME='<data root>' "$(command -v sash)" status
# When finished:
sudo env SASH_HOME='<data root>' "$(command -v sash)" stop
```

A dashboard Core-only restart cannot elevate the daemon. If enable rolls back, restart the whole daemon elevated first, then enable again in the dashboard. Use the same privilege context/root thereafter: private `0600` files can remain root-owned after stop. Do not weaken permissions or assume stopping restores ownership.

### Verification and rollback

Desired state and runtime observation are separate: `sash status --json` reports `tun.desired` and `tun.active` (`true`, `false` or `null`). The dashboard distinguishes pending start, active, inactive, unverified (including a running but unhealthy Core), and unexpectedly active while desired off. A failed enable leaves the switch at the committed value and retains failure details inline; a successful save followed by an unavailable refresh is reported as saved, not rolled back.

Every settings-driven restart with TUN desired on, and every active profile/config hot reload with TUN desired on, requires the Core to report `tun.enable: true`. Inactive or unverified results restore the previous settings/profile/config and runtime as applicable. Rollback failures are reported explicitly and require investigation. Non-Windows direct startup may report a healthy Core with inactive/unverified TUN; controller readiness alone is not TUN success. Windows direct startup with desired TUN is refused.

**Active means the Core reports an active TUN listener.** It does not verify network reachability, DNS resolution, or that all device traffic passes through TUN.

### Profile TUN and DNS policy

Sash owns TUN `enable` from the boolean `tun` in `sash.json`, plus `auto-route: true`, `auto-detect-interface: true` and `dns-hijack: ["any:53"]`. The supported Core handles both TCP and UDP port 53 with `any:53`. The active profile may supply only these advanced TUN fields:

| Profile key | Accepted value | If absent |
| :--- | :--- | :--- |
| `tun.stack` | `mixed`, `system`, or `gvisor` | `mixed` |
| `tun.mtu` | Integer from `576` to `65535` | Omitted; Core default retained |
| `tun.strict-route` | Boolean | Omitted; Core default retained |

In direct-mode rendering, other profile TUN fields are ignored. Service mode additionally enforces a limited audited configuration allowlist; unsupported fields that reach its policy boundary are explicitly rejected, not silently ignored. Invalid advanced values or a malformed TUN object are rejected when TUN is enabled.

With TUN on, an existing profile DNS object is preserved, except a missing `dns.enable` is normalized to `true`. Explicit `enable: false`, a non-boolean enable value or a malformed DNS object fails before publication. If the profile has no DNS section, Sash generates:

```yaml
dns:
  enable: true
  ipv6: true # follows top-level ipv6; false when top-level ipv6 is false
  enhanced-mode: redir-host
  nameserver:
    - https://cloudflare-dns.com/dns-query
    - https://dns.google/dns-query
  default-nameserver:
    - 1.1.1.1
    - 8.8.8.8
```

With TUN off, Sash makes no DNS changes. Sash adds neither a separate DNS listen socket nor OS DNS edits; existing profile DNS choices remain profile-owned.

### Service configuration policy

Parsed profiles become bounded bundles; the native helper independently checks option names/types, provider roles, paths and sizes, then publishes protected JSON (valid Core-format YAML). Unsupported fields/features fail explicitly. Arbitrary filesystem paths, unapproved listeners/controllers, raw Core config reload/upgrade/restart APIs and executable paths over IPC are forbidden. Use Sash profile/settings routes, not `PUT /core/api/configs`.

HTTP providers are materialized by the unprivileged daemon; fetch URLs/headers do not enter the protected runtime. Required known geodata uses local regular files or the private `service-assets/` cache with official release metadata and mandatory digest verification. The service does not fetch network resources. Background provider refresh rebuilds validated bundles; failure retains the running configuration and retries. See [the protocol and limits](./service-protocol.md).

Do not enable TUN in automated smoke tests. Native fixture tests do not establish SCM installation, boot recovery, real routing or DNS correctness; verify those manually in an isolated Windows VM with maintainer approval.

---

## 5. Data Directory Layout

| Platform | Default Path |
| :--- | :--- |
| Windows | `%LOCALAPPDATA%\Sash` |
| macOS | `~/Library/Application Support/Sash` |
| Linux | `$XDG_DATA_HOME/sash` or `~/.local/share/sash` |

Override the root with an absolute `SASH_HOME` path.

- `bin/`: installed core executable; `.bak` is retained during an update transaction.
- `config.yaml`: active runtime configuration rendered from the active profile or the DIRECT-only default; qualifying pre-profile files are preserved during one-time import.
- `sash.json`: Sash settings and local control secrets.
- `profiles/index.json`: profile metadata and active profile id.
- `profiles/<id>.yaml`: validated local copy of each downloaded/imported profile.
- `state/sashd.pid`, `state/sash.pid`: atomic daemon/Core discovery records.
- `state/system-proxy.json`: pre-takeover proxy snapshot and ownership phase.
- `state/install.json`: canonical installed Core version record.
- `state/core-install-transaction.json`: first-install publication journal; interrupted publishing rolls back, while a committed marker is only cleared.
- `state/core-update-transaction.json`: previous/target install records and update phase; retained with `.bak` until managed runtime health and restoration succeed.
- `state/*.lock`: daemon, runtime, mutation, settings and proxy ownership leases.
- `logs/`: direct-mode Core and daemon stdout/stderr logs. Service Core diagnostics are private under protected service storage; do not assume `sash logs` reads them. The WebUI log stream remains available through the authenticated gateway when Core is healthy.
- `ui/` *(optional)*: custom dashboard override.

State files are written with mode `0o600` on POSIX where applicable. `SASH_HOME` must be on a local filesystem supporting atomic rename and hard links.

---

## 6. Troubleshooting

- **System proxy recovery is blocked:** another application changed managed values or the ownership journal is corrupt. Keep the Core running, inspect `state/system-proxy.json` and the current OS proxy, then repair explicitly; Sash will not overwrite an unrecognized state.
- **Daemon/Core ownership is corrupt:** inspect `state/*.lock` and PID records. Sash intentionally fails closed instead of deleting uncertain ownership records.
- **Profile update failed:** inspect the profile card's error or use its update button; generated candidates are checked by the installed Core before commit, and the last valid running config remains active on validation/reload failure.
- **Corrupt settings/profile index:** repair the JSON file or move it aside; Sash intentionally does not overwrite corrupt state.
- **Daemon errors:** `sash logs --daemon --errors`.
- **Core errors (direct mode):** `sash logs --errors`. Service Core file logs remain private under the protected installation; use the authenticated dashboard log stream when Core is healthy. Log tails and follow-mode reads use bounded chunks, so large logs do not require one whole-file allocation.
- **Shutdown returned an error:** cleanup was not completed; the daemon remains listening and scheduled profile updates remain active. Resolve the reported proxy/Core issue and retry `sash stop`.
- **Core binary/metadata mismatch:** Sash will not execute a binary unless `state/install.json` is valid and agrees that an installation exists. An interrupted `.unlock-probe` is restored automatically when it is the only copy; if both files exist with different bytes, Sash preserves both and fails closed. Inspect them explicitly or run `sash update --force` after resolving the conflict.
- **Force a validated core reinstall:** `sash update --force`.
