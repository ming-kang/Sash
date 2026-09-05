# Sash User & Operations Guide

Sash is a lightweight command-line companion and web dashboard for managing a rule-based network core.

---

## 1. Quick Start

```sh
sash start
sash web        # open the dashboard: download a subscription, pick nodes, toggle the system proxy
sash status
```

Profiles, the system proxy and all runtime settings are managed from the web dashboard; the CLI covers lifecycle, logs and upgrades.

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

Runtime settings (`mixed-port`, `tun`, `allow-lan`, `system-proxy`) are managed from the WebUI Settings page, and the entire `sash.json` can be edited as JSON from the same page ("Edit settings file"); invalid documents are rejected without touching the disk. `daemonSecret` changes apply immediately; `daemonPort` changes are saved but require a manual `sash restart` to rebind the listener.

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
| `mixedPort` | `7890` | Local HTTP/SOCKS5 mixed inbound port. The CLI key is `mixed-port`. |
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

Settings changes are prepared as an all-or-nothing candidate: active configuration is validated before settings/config publication, and a failed restart restores the previous candidate where possible. Turning the system proxy off persists the desired off state before OS cleanup; if cleanup fails, toggle the system proxy off again from the WebUI after resolving the OS error.

---

## 4. TUN Mode

TUN requires the whole Sash daemon to run with elevated privileges. Stop the current daemon and save the setting while Sash is offline — toggle it in the WebUI Settings page before stopping, or set `"tun": true` in `sash.json` directly:

```sh
sash stop
# ensure TUN is on (WebUI Settings page, or edit sash.json)
```

On Windows, open PowerShell as Administrator:

```powershell
sash start
```

The default `%LOCALAPPDATA%\Sash` data root remains the same when the current Windows user elevates. Only copy an explicitly customized `SASH_HOME` into the Administrator shell.

On macOS or Linux, `sudo` can change the default home directory. Read the current data root and pass it explicitly while starting Sash as root:

```sh
sash status  # note the printed data root
sudo env SASH_HOME='<data root printed above>' "$(command -v sash)" start
```

While that elevated daemon is running on macOS or Linux, use the same `sudo` and `SASH_HOME` prefix for later lifecycle commands such as `status` or `stop`, so they target the same runtime and can read its protected state.

If TUN was already saved as on, just start Sash elevated. Because a full `sash restart` replaces the daemon itself, running it from the elevated shell is equivalent to `sash stop` + `sash start` here; restarting only the Core from the dashboard does not elevate `sashd`.

Sash distinguishes the desired setting from the Core's actual runtime state: `sash status` reports `on (active)`, `on (inactive)`, `on (unverified)` or `on (runtime unknown)`, and `sash status --json` reports `tun.desired` separately from `tun.active` (`true`, `false` or `null`). Privilege guidance is shown only after a responsive, healthy running Core explicitly reports inactive or unverified TUN state.

When a running Core is switched from TUN off to on, Sash reads back `tun.enable` from the Core before committing the setting. If the Core remains inactive or cannot be verified, the settings/config transaction and prior runtime are restored. An inactive result includes the platform-appropriate elevated `sash restart` instructions above. A TUN setting saved while the Core is stopped can only be verified on the next start; startup leaves the ordinary proxy Core available and reports any inactive or unverified TUN state explicitly. If an elevated start still leaves TUN inactive, inspect the Core error log.

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
