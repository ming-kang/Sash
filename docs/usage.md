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
| `sash stop` | Disable system proxy, stop the core and shut down the daemon. |
| `sash restart` | Restart the managed core process. |
| `sash status [--json]` | Show daemon/core state, active profile, endpoints and system proxy state. |
| `sash logs [-n N] [-f] [--errors] [--daemon]` | View core or daemon logs; `-f` follows new output. |

### System Proxy Control

| Command | Description |
| :--- | :--- |
| `sash proxy on` | Route OS-level traffic through the configured mixed port. |
| `sash proxy off` | Disable the OS-level proxy; also works when the daemon is stopped and persists the desired state as off. |
| `sash proxy status` | Show desired, daemon-applied and OS-reported proxy state. |

Changing `mixed-port` while the system proxy is enabled restarts the core and rebinds the OS proxy to the new port.

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
| `sash upgrade [--version V]` | Upgrade the Sash package through npm. |
| `sash version` | Print the Sash package version. |

Core updates retain `<core>.bak` until the staged binary and, when previously running, its controller health check pass. A failure restores both the previous binary and install metadata.

---

## 3. Configuration Reference (`sash.json`)

| Key | Default | Description |
| :--- | :--- | :--- |
| `mixedPort` / `mixed-port` | `17890` | Local HTTP/SOCKS5 mixed inbound port. |
| `controller` | `127.0.0.1:9090` | Internal controller listen address. |
| `daemonPort` | `19090` | Daemon API and WebUI port. |
| `secret` | *(random)* | Internal controller secret. It is never returned by the public status API. |
| `daemonSecret` | *(random)* | CLI bearer secret for state-changing daemon requests. |
| `systemProxy` | `false` | Desired OS-level system proxy state. |
| `tun` | `false` | Enable the TUN inbound; requires elevated privileges. |
| `allowLan` | `false` | Accept proxy traffic from other devices. |

A legacy `subscriptionUrl` key is migrated once into `profiles/index.json` and then removed. Installed core version metadata lives in `state/install.json`, not in `sash.json`.

Malformed `sash.json` or `profiles/index.json` is rejected without being overwritten. Repair or remove the damaged file explicitly instead of relying on silent defaults.

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
- `state/sashd.pid`, `state/mihomo.pid`: atomic PID records.
- `state/install.json`: canonical installed core version record.
- `logs/`: core and daemon stdout/stderr logs.
- `ui/` *(optional)*: custom dashboard override.

State files are written with mode `0o600` on POSIX where applicable.

---

## 6. Troubleshooting

- **System proxy points to a dead port:** run `sash proxy off`, inspect `sash status`, then start/restart again.
- **Profile update failed:** inspect the profile card's error or run `sash sub update`; generated candidates are checked by the installed Core before commit, and the last valid running config remains active on validation/reload failure.
- **Corrupt settings/profile index:** repair the JSON file or move it aside; Sash intentionally does not overwrite corrupt state.
- **Daemon errors:** `sash logs --daemon --errors`.
- **Core errors:** `sash logs --errors`.
- **Force a validated core reinstall:** `sash update --force`.
