# Sash User & Operations Guide

Sash is a lightweight command-line companion and web dashboard for managing a rule-based network core.

---

## 1. Quick Start

```sh
sash start
sash sub set https://example.com/profile.yaml
sash proxy on
sash web
sash status
```

`sub set` downloads the profile, validates it, stores it locally and activates it. Additional profiles downloaded from the WebUI do not replace the active selection unless no profile is active.

---

## 2. CLI Command Reference

### Lifecycle Management

| Command | Description |
| :--- | :--- |
| `sash start` | Install missing components and start the background daemon and core. |
| `sash stop` | Restore the pre-Sash system proxy, stop the Core and shut down the daemon. |
| `sash restart` | Restart the managed core process. |
| `sash status [--json]` | Show daemon/core state, active profile, endpoints and system proxy state. |
| `sash logs [-n N] [-f] [--errors] [--daemon]` | View core or daemon logs; `-f` follows new output. |

### System Proxy Control

| Command | Description |
| :--- | :--- |
| `sash proxy on` | Route OS-level traffic through the configured mixed port. |
| `sash proxy off` | Restore the proxy snapshot captured before Sash took ownership; also works while the daemon is stopped. |
| `sash proxy status` | Show desired, daemon-applied and OS-reported proxy state. |

Changing `mixed-port` while the system proxy is enabled restores the old binding before restart and takes a fresh snapshot before applying the new port.

Sash does not blindly turn off an existing proxy. It stores a private ownership journal before takeover and restores only while managed OS values still match the original/Sash transition. If another application changes those values, Sash refuses to overwrite them. Windows and macOS include manual and automatic proxy state; Linux system-proxy automation currently requires GNOME `gsettings`.

### Web Dashboard

| Command | Description |
| :--- | :--- |
| `sash web` | Open `http://127.0.0.1:19090/ui/`. |
| `sash web --no-open` | Print the dashboard URL without opening a browser. |

### Profiles

| Command | Description |
| :--- | :--- |
| `sash sub set <url>` | Download or update a remote profile and make it active. |
| `sash sub update` | Refresh the active remote profile and reload it when the core is running. |
| `sash sub show` | List all stored profiles and mark the active selection. |
| `sash sub unset` | Deselect the active profile and use the DIRECT-only default; stored profiles remain on disk. |

The WebUI Profiles page additionally supports local YAML import, per-profile update/delete, switching the active profile and Update All. Remote profiles use the update interval advertised by the provider, defaulting to 24 hours. The daemon checks for due updates every 15 minutes.

### Configuration Management

| Command | Description |
| :--- | :--- |
| `sash config show` | Inspect paths, active profile and managed settings. |
| `sash config set <key> [value]` | Set `mixed-port`, `controller`, `secret`, `tun`, `allow-lan` or `system-proxy`. |

### Maintenance & Upgrades

| Command | Description |
| :--- | :--- |
| `sash update [--version V] [--force]` | Download and validate a replacement core, then swap it in transactionally. |
| `sash upgrade [--version V]` | Upgrade the Sash package through npm; requires `sashd` to be stopped first. |
| `sash version` | Print the Sash package version. |

Core updates temporarily stop `sashd`, retain `<core>.bak`, and restore the previous daemon/Core state afterward. Downloads require official GitHub SHA-256 asset metadata; mirrors are accepted only as transports for bytes matching that digest. Archives are capped at 128 MiB, staged binaries must report the exact requested version, and the staged Core validates the freshly generated active configuration before publication.

---

## 3. Configuration Reference (`sash.json`)

| Key | Default | Description |
| :--- | :--- | :--- |
| `schemaVersion` | `1` | On-disk settings schema; managed by Sash. |
| `mixedPort` / `mixed-port` | `17890` | Local HTTP/SOCKS5 mixed inbound port. |
| `controller` | `127.0.0.1:9090` | Internal controller listen address; only loopback hosts are accepted. |
| `daemonPort` | `19090` | Daemon API and WebUI port. |
| `secret` | *(random)* | Internal controller secret. It is never returned by the public status API. |
| `daemonSecret` | *(random)* | CLI bearer secret for state-changing daemon requests. |
| `systemProxy` | `false` | Desired OS-level system proxy state. |
| `tun` | `false` | Enable the TUN inbound; requires elevated privileges. |
| `allowLan` | `false` | Accept proxy traffic from other devices. |

A legacy `subscriptionUrl` key is migrated once into `profiles/index.json` and then removed. Installed core version metadata lives in `state/install.json`, not in `sash.json`.

Malformed, future-version or unknown-field `sash.json` documents and malformed `profiles/index.json` files are rejected without being overwritten. Repair or move the damaged file explicitly instead of relying on silent defaults.

---

## 4. TUN Mode

```sh
sash config set tun on
sash restart
```

TUN mode normally requires Administrator/root privileges. Do not enable it in automated smoke tests.

---

## 5. Data Directory Layout

| Platform | Default Path |
| :--- | :--- |
| Windows | `%LOCALAPPDATA%\Sash` |
| macOS | `~/Library/Application Support/Sash` |
| Linux | `$XDG_DATA_HOME/sash` or `~/.local/share/sash` |

Override the root with an absolute `SASH_HOME` path.

- `bin/`: installed core executable; `.bak` is retained during an update transaction.
- `config.yaml`: generated active runtime configuration.
- `sash.json`: Sash settings and local control secrets.
- `profiles/index.json`: profile metadata and active profile id.
- `profiles/<id>.yaml`: validated local copy of each downloaded/imported profile.
- `state/sashd.pid`, `state/sash.pid`: atomic daemon/Core discovery records.
- `state/system-proxy.json`: pre-takeover proxy snapshot and ownership phase.
- `state/install.json`: canonical installed Core version record.
- `state/*.lock`: daemon, runtime, mutation, settings and proxy ownership leases.
- `logs/`: core and daemon stdout/stderr logs.
- `ui/` *(optional)*: custom dashboard override.

State files are written with mode `0o600` on POSIX where applicable. `SASH_HOME` must be on a local filesystem supporting atomic rename and hard links.

---

## 6. Troubleshooting

- **System proxy recovery is blocked:** another application changed managed values or the ownership journal is corrupt. Keep the Core running, inspect `state/system-proxy.json` and the current OS proxy, then repair explicitly; Sash will not overwrite an unrecognized state.
- **Daemon/Core ownership is corrupt:** inspect `state/*.lock` and PID records. Sash intentionally fails closed instead of deleting uncertain ownership records.
- **Profile update failed:** inspect the profile card's error or run `sash sub update`; generated candidates are checked by the installed Core before commit, and the last valid running config remains active on validation/reload failure.
- **Corrupt settings/profile index:** repair the JSON file or move it aside; Sash intentionally does not overwrite corrupt state.
- **Daemon errors:** `sash logs --daemon --errors`.
- **Core errors:** `sash logs --errors`.
- **Force a validated core reinstall:** `sash update --force`.
