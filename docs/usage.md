# Sash User & Operations Guide

Sash is a lightweight command-line companion and web dashboard for managing a rule-based network core.

---

## 1. Quick Start

```sh
sash start
sash web        # open the dashboard: download a subscription, pick nodes, toggle the system proxy
sash status
```

Profiles, the system proxy and all runtime settings are managed from the web dashboard; the CLI covers lifecycle, login startup, logs and upgrades.

---

## 2. CLI Command Reference

### Lifecycle Management

| Command | Description |
| :--- | :--- |
| `sash start` | Install missing components, ensure the background daemon is running, then reconcile/start the core. It is safe to repeat. |
| `sash stop` | Restore the pre-Sash system proxy, stop the Core and shut down the daemon; exits with an error if safe shutdown cannot be verified. |
| `sash restart` | Restart the whole runtime: the daemon exits through its maintenance boundary and a fresh daemon starts the core. |
| `sash status [--json]` | Show daemon/core state, active profile, endpoints, automatic startup and system proxy state; incomplete observations exit with code 2. |
| `sash auto [on\|off\|status]` | Toggle or explicitly set login startup; `status` only inspects the OS registration. |
| `sash logs [-n N] [-f] [--errors] [--daemon]` | View core or daemon logs; `-f` follows new output. |
| `sash logs --startup [-n N] [-f]` | View login startup attempts and failures, including settings errors before daemon startup. |

### Status JSON and exit codes

`sash status --json` emits the versioned `schemaVersion: 1` contract below. Unobservable runtime values are `null`; they are never changed to `false` merely because a query timed out.

```json
{
  "schemaVersion": 1,
  "complete": true,
  "healthy": true,
  "queryError": null,
  "autostart": {
    "state": "off",
    "canEnable": true,
    "reason": null
  },
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
| `sash web` | Authorize this browser and open `http://127.0.0.1:19090/ui/`. |
| `sash web --no-open` | Print the dashboard URL without opening or authorizing a browser. |

Run `sash web` as the user who runs Sash, with the same `SASH_HOME`. It uses a private local handoff to authorize the browser automatically. A bare dashboard address shows a read-only connection page; it cannot obtain control access from public health information. The handoff expires after 90 seconds and works once. If it expires before the browser opens, rerun the command. An authorized tab can be refreshed, but a daemon restart requires a new `sash web` authorization. Browser storage restrictions keep the session in memory only, so those browsers also require authorization after a page reload.

### Profiles

Profiles are managed from the WebUI Profiles page: download from a subscription URL, import a local YAML file, update one or all profiles, rename, edit content, switch the active profile and delete. Remote profiles use the update interval advertised by the provider, defaulting to 24 hours. The daemon checks for due updates every 15 minutes.

### Settings

Runtime settings (`mixedPort`, `allowLan`, `systemProxy`) are managed from the WebUI Settings page, and the entire `sash.json` can be edited as JSON from the same page ("Edit settings file"); invalid documents are rejected without touching the disk. `daemonSecret` changes apply immediately; `daemonPort` changes are saved but require a manual `sash restart` to rebind the listener.

The **Start at Login** card manages the current user's OS startup entry. It uses
the same service as `sash auto`, reports the observed OS state and can repair stale
or OS-disabled entries. Enabling requires a direct global npm installation;
changing startup does not restart the current runtime. See [Automatic Startup](./autostart.md).

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
| `mixedPort` | `7890` | Local HTTP/SOCKS5 mixed inbound port. |
| `controller` | `127.0.0.1:9090` | Internal controller listen address; only loopback hosts are accepted. |
| `daemonPort` | `19090` | Daemon API and WebUI port. |
| `secret` | *(random)* | Internal controller secret. It is never returned by the public status API. |
| `daemonSecret` | *(random)* | CLI bearer secret for state-changing daemon requests. |
| `systemProxy` | `false` | Desired OS-level system proxy state. |
| `tun` | `false` | Legacy compatibility field; always off in 0.1.1. Existing true values migrate to false on load; new true values are rejected. |
| `allowLan` | `false` | Accept proxy traffic from other devices. |

A legacy `subscriptionUrl` key is migrated once into `profiles/index.json` and then removed. It has priority over legacy `config.yaml` import. If no `profiles/index.json` has ever been created, startup/offline initialization may import an existing `config.yaml` once as the active local profile named `Imported config` (`url: ""`, updates disabled). A present empty index opts out. To avoid importing Sash's own generated default, the file must be valid core-format YAML and contain non-default routing content after managed keys are removed: nonempty proxies/providers, or nonempty rules/groups differing from the DIRECT-only default. The runtime `config.yaml` is kept unchanged during import; later profile application re-renders and validates it. Invalid YAML/config fails closed without overwriting the file.

Installed core version metadata lives in `state/install.json`, not in `sash.json`.

Malformed, future-version or unknown-field `sash.json` documents and malformed `profiles/index.json` files are rejected without being overwritten. Secrets cannot be blank or contain control characters, the controller must remain loopback-only, and the mixed, controller and daemon ports must all differ. Repair or move a damaged file explicitly instead of relying on silent defaults.

Settings changes are prepared as an all-or-nothing candidate: active configuration is validated before settings/config publication, and a failed restart restores the previous candidate where possible. Turning the system proxy off persists the desired off state before OS cleanup; if cleanup fails, toggle the system proxy off again from the WebUI after resolving the OS error.

---

## 4. Network Scope in 0.1.1

This release supports local HTTP/SOCKS endpoints, profile rules and reversible system-proxy integration. TUN and Windows Service Mode are developed on the [feat/tun-service-mode branch](https://github.com/ming-kang/Sash/tree/feat/tun-service-mode).

The dashboard has no TUN switch or service installation controls. Settings updates reject `tun: true`; loading an otherwise valid older settings file migrates that value to `false` atomically. Generated configurations explicitly set `tun.enable: false`, including on reload. Profiles containing a separate TUN listener are rejected before publication. Original profile files and profile-owned DNS/provider settings remain unchanged. The JSON status contract retains its TUN observation fields for compatibility.

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
- **Sash did not start at login:** inspect `sash auto status` and `sash logs --startup`. Repair stale or OS-disabled entries with `sash auto on`; Linux startup before login requires user lingering.
- **Core errors:** `sash logs --errors`. Log tails and follow-mode reads use bounded chunks, so large logs do not require one whole-file allocation.
- **Shutdown returned an error:** cleanup was not completed; the daemon remains listening and scheduled profile updates remain active. Resolve the reported proxy/Core issue and retry `sash stop`.
- **Core binary/metadata mismatch:** Sash will not execute a binary unless `state/install.json` is valid and agrees that an installation exists. An interrupted `.unlock-probe` is restored automatically when it is the only copy; if both files exist with different bytes, Sash preserves both and fails closed. Inspect them explicitly or run `sash update --force` after resolving the conflict.
- **Force a validated core reinstall:** `sash update --force`.
