# Sash User & Operations Guide

Sash is a lightweight command-line companion and web dashboard for managing a rule-based network core.

---

## 1. Quick Start

```sh
sash start
sash web        # open the dashboard: download a subscription, pick nodes, toggle the system proxy
sash status
```

Profiles, the system proxy and runtime settings are managed from the web dashboard; the CLI covers lifecycle, logs, upgrades and the focused `sash tun <on|off>` control.

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

### TUN Control

| Command | Description |
| :--- | :--- |
| `sash tun <on\|off>` | Save desired TUN state through the verified, responsive daemon's `PATCH /sash/settings`, then report observed runtime state. |

This command uses the same `SettingsService` as the WebUI. It never auto-starts the daemon/Core, elevates privileges or edits settings offline. A running daemon with Core stopped saves intent pending the next start. A successful save remains successful if the follow-up status refresh is unavailable; inspect `sash status` later. See [TUN Mode](#4-tun-mode) for setup and rollback behavior.

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

Runtime settings (`mixedPort`, `tun`, `allowLan`, `systemProxy`) are managed from the WebUI Settings page (`tun` also has a CLI control), and the entire `sash.json` can be edited as JSON from the same page ("Edit settings file"); invalid documents are rejected without touching the disk. `daemonSecret` changes apply immediately; `daemonPort` changes are saved but require a manual `sash restart` to rebind the listener.

### Maintenance & Upgrades

| Command | Description |
| :--- | :--- |
| `sash update [--version V] [--force]` | Download and validate a replacement core, then swap it in transactionally. |
| `sash upgrade [--version V]` | Upgrade the Sash package through npm; requires `sashd` to be stopped first. |
| `sash version` | Print the Sash package version. |

Core updates download and validate before shutdown, then use an authenticated maintenance request that atomically snapshots whether Core was running while restoring proxy state and stopping `sashd`. After daemon exit, a durable update journal records the previous/target install records before the executable swap. A previously running Core is health-checked immediately; when Core was stopped, `<core>.bak` and the journal remain until the next managed `sash start` passes controller health/version checks. A failed first start restores the previous binary and install record before attempting to restart it. Downloads require official GitHub SHA-256 asset metadata; mirrors are accepted only as transports for bytes matching that digest, and all mirror/redirect/body attempts share a bounded absolute deadline. Archives are capped at 128 MiB, Windows ZIPs must contain the expected upstream Core executable basename, staged binaries must report the exact requested version, and the staged Core validates the freshly generated active configuration before publication.

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
| `tun` | `false` | Enable the TUN inbound; requires elevated privileges. |
| `allowLan` | `false` | Accept proxy traffic from other devices. |

A legacy `subscriptionUrl` key is migrated once into `profiles/index.json` and then removed. It has priority over legacy `config.yaml` import. If no `profiles/index.json` has ever been created, startup/offline initialization may import an existing `config.yaml` once as the active local profile named `Imported config` (`url: ""`, updates disabled). A present empty index opts out. To avoid importing Sash's own generated default, the file must be valid core-format YAML and contain non-default routing content after managed keys are removed: nonempty proxies/providers, or nonempty rules/groups differing from the DIRECT-only default. The runtime `config.yaml` is kept unchanged during import; later profile application re-renders and validates it. Invalid YAML/config fails closed without overwriting the file.

Installed core version metadata lives in `state/install.json`, not in `sash.json`.

Malformed, future-version or unknown-field `sash.json` documents and malformed `profiles/index.json` files are rejected without being overwritten. Secrets cannot be blank or contain control characters, the controller must remain loopback-only, and the mixed, controller and daemon ports must all differ. Repair or move a damaged file explicitly instead of relying on silent defaults.

Core-related settings/config changes are validated before publication and compensated on restart failure. A multi-key settings request is not wholly atomic: Core/settings changes can commit before a separate system-proxy transaction fails. Turning the system proxy off persists desired off before OS cleanup. An explicit `systemProxy: false` retries release even when desired state is already false; it never authorizes changing an unrelated proxy. If cleanup fails, toggle off again after resolving the OS error.

---

## 4. TUN Mode

### Privileges and activation

TUN requires the **whole Sash daemon** to run with elevated privileges. The CLI and WebUI do not elevate it; a dashboard Core-only restart cannot change daemon privileges. If an online enable fails, Sash rolls back the setting, generated config and prior runtime. Restart elevated **first**, using the same data root, then enable again.

On Windows, open PowerShell as Administrator under the **same Windows user**:

```powershell
# Only for a custom data root: copy its exact SASH_HOME into this shell first.
# $env:SASH_HOME = 'C:\your\custom\Sash'
sash restart
sash tun on
sash status
```

Same-user elevation retains the default `%LOCALAPPDATA%\Sash` root. An explicitly customized `SASH_HOME` must be copied into the Administrator shell; do not silently switch instances.

On macOS or Linux, note the data root from `sash status` before elevation and pass it explicitly (`sudo` can change the default home):

```sh
sudo env SASH_HOME='<data root>' "$(command -v sash)" restart
sudo env SASH_HOME='<data root>' "$(command -v sash)" tun on
sudo env SASH_HOME='<data root>' "$(command -v sash)" status
# When finished:
sudo env SASH_HOME='<data root>' "$(command -v sash)" stop
```

Use the same privilege context and `SASH_HOME` for subsequent commands. Elevated writes can leave private settings, state and logs root-owned with mode `0600`; even after stopping, unelevated commands may no longer be able to read them. Stopping does not restore file ownership. Do not assume seamless unelevated access or weaken private-file permissions to work around this.

If desired TUN is already on, the elevated restart applies it; the subsequent `tun on` is idempotent. If Core is stopped but the daemon is responsive, `sash tun on` only saves intent for its next start. Normal `sash start` permits an ordinary non-TUN Core fallback with an inactive/unverified warning rather than treating controller readiness as TUN success. If elevated startup still reports inactive, inspect `sash logs --errors` in the same privilege context.

### Verification and rollback

Desired state and runtime observation are separate: `sash status --json` reports `tun.desired` and `tun.active` (`true`, `false` or `null`). The dashboard distinguishes pending start, active, inactive, unverified (including a running but unhealthy Core), and unexpectedly active while desired off. A failed enable leaves the switch at the committed value and retains failure details inline; a successful save followed by an unavailable refresh is reported as saved, not rolled back.

Every settings-driven restart with TUN desired on, and every active profile/config hot reload with TUN desired on, requires the Core to report `tun.enable: true`. Inactive or unverified results restore the previous settings/profile/config and runtime as applicable. Rollback failures are reported explicitly and require investigation. Ordinary startup remains the non-strict fallback path described above.

**Active means the Core reports an active TUN listener.** It does not verify network reachability, DNS resolution, or that all device traffic passes through TUN.

### Profile TUN and DNS policy

Sash owns TUN `enable` from the boolean `tun` in `sash.json`, plus `auto-route: true`, `auto-detect-interface: true` and `dns-hijack: ["any:53"]`. The supported Core handles both TCP and UDP port 53 with `any:53`. The active profile may supply only these advanced TUN fields:

| Profile key | Accepted value | If absent |
| :--- | :--- | :--- |
| `tun.stack` | `mixed`, `system`, or `gvisor` | `mixed` |
| `tun.mtu` | Integer from `576` to `65535` | Omitted; Core default retained |
| `tun.strict-route` | Boolean | Omitted; Core default retained |

Other profile TUN fields are ignored. Invalid advanced values or a malformed TUN object are rejected when TUN is enabled.

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

Do not enable TUN in automated smoke tests.

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
- `logs/`: core and daemon stdout/stderr logs.
- `ui/` *(optional)*: custom dashboard override.

State files are written with mode `0o600` on POSIX where applicable. `SASH_HOME` must be on a local filesystem supporting atomic rename and hard links.

---

## 6. Troubleshooting

- **System proxy recovery is blocked:** another application changed managed values or the ownership journal is corrupt. Keep the Core running, inspect `state/system-proxy.json` and the current OS proxy, then repair explicitly; Sash will not overwrite an unrecognized state.
- **Daemon/Core ownership is corrupt:** inspect `state/*.lock` and PID records. Sash intentionally fails closed instead of deleting uncertain ownership records.
- **Profile update failed:** inspect the profile card's error or use its update button; generated candidates are checked by the installed Core before commit, and the last valid running config remains active on validation/reload failure.
- **Corrupt settings/profile index:** repair the JSON file or move it aside; Sash intentionally does not overwrite corrupt state.
- **Daemon errors:** `sash logs --daemon --errors`.
- **Core errors:** `sash logs --errors`. Log tails and follow-mode reads use bounded chunks, so large logs do not require one whole-file allocation.
- **Shutdown returned an error:** cleanup was not completed; the daemon remains listening and scheduled profile updates remain active. Resolve the reported proxy/Core issue and retry `sash stop`.
- **Core binary/metadata mismatch:** Sash will not execute a binary unless `state/install.json` is valid and agrees that an installation exists. An interrupted `.unlock-probe` is restored automatically when it is the only copy; if both files exist with different bytes, Sash preserves both and fails closed. Inspect them explicitly or run `sash update --force` after resolving the conflict.
- **Force a validated core reinstall:** `sash update --force`.
