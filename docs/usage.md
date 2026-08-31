# Sash User & Operations Guide

Sash is a lightweight command-line companion and web dashboard for managing a rule-based network core.

---

## 1. Quick Start

```sh
# Start background supervisor daemon and core
sash start

# Enable OS-level system proxy
sash proxy on

# Import a remote subscription profile
sash sub set https://example.com/subscription.yaml

# Open the built-in web dashboard
sash web

# Check runtime state and endpoints
sash status

# Stop sash (disables system proxy and shuts down core)
sash stop
```

---

## 2. CLI Command Reference

### Lifecycle Management

| Command | Description |
| :--- | :--- |
| `sash start` | Install missing components and start sash background daemon. |
| `sash stop` | Stop sash (gracefully closes core, disables system proxy, shuts down daemon). |
| `sash restart` | Restart the core process and re-apply configurations. |
| `sash status [--json]` | Show runtime status, core state, system proxy state, and endpoints. |
| `sash logs [-n N] [-f] [--errors] [--daemon]` | View logs (`--daemon` for supervisor logs, `-f` to follow). |

### System Proxy Control

| Command | Description |
| :--- | :--- |
| `sash proxy on` | Route OS-level network traffic through Sash's mixed proxy port. |
| `sash proxy off` | Disable OS-level system proxy (works even when daemon is stopped). |
| `sash proxy status` | Show current OS and desired system proxy state. |

### Web Dashboard

| Command | Description |
| :--- | :--- |
| `sash web` | Open the built-in web dashboard at `http://127.0.0.1:19090/ui/`. |
| `sash web --no-open` | Print the dashboard URL to stdout without opening a browser. |

### Subscription & Profiles

| Command | Description |
| :--- | :--- |
| `sash sub set <url>` | Set remote subscription profile URL, validate YAML, and hot-reload core. |
| `sash sub update` | Refetch subscription and hot-reload configuration in-place. |
| `sash sub show` | Display current subscription URL and configuration file path. |
| `sash sub unset` | Remove subscription and revert to DIRECT-only default configuration. |

### Configuration Management

| Command | Description |
| :--- | :--- |
| `sash config show` | Inspect file paths and current managed settings. |
| `sash config set <key> [value]` | Adjust a managed key (`mixed-port`, `controller`, `secret`, `tun`, `allow-lan`, `system-proxy`). |

### Maintenance & Upgrades

| Command | Description |
| :--- | :--- |
| `sash update [--version V] [--force]` | Upgrade the core binary (atomic swap with automatic rollback). |
| `sash upgrade [--version V]` | Upgrade Sash CLI itself via npm. |
| `sash version` | Print current Sash version. |

---

## 3. Configuration Reference (`sash.json`)

Settings are stored in `<root>/sash.json`. Settable keys include:

| Key | Default | Description |
| :--- | :--- | :--- |
| `mixed-port` | `17890` | Local port for HTTP & SOCKS5 mixed inbound listener. |
| `controller` | `127.0.0.1:9090` | Listen address of the internal core controller. |
| `daemonPort` | `19090` | Listen port for `sashd` API gateway and WebUI dashboard. |
| `secret` | *(random)* | Internal core controller secret (auto-generated, 48 hex characters). |
| `systemProxy` | `false` | Desired OS system proxy state. |
| `tun` | `false` | TUN mode virtual network interface toggle (requires administrator/root). |
| `allowLan` | `false` | Accept proxy traffic from other devices on the local network. |

---

## 4. TUN Mode (Virtual Network Interface)

TUN mode creates a virtual network interface that captures all device traffic at the IP layer:

```sh
# Enable TUN mode in settings
sash config set tun on

# Restart core to apply
sash restart
```

> **Note**: TUN mode requires elevated privileges (Run as Administrator on Windows, `sudo` or root on macOS and Linux).

---

## 5. Data Directory Layout

| Platform | Default Path |
| :--- | :--- |
| Windows | `%LOCALAPPDATA%\Sash` |
| macOS | `~/Library/Application Support/Sash` |
| Linux | `$XDG_DATA_HOME/sash` or `~/.local/share/sash` |

Override directory path using the `SASH_HOME` environment variable (e.g. `SASH_HOME=/custom/path sash start`).

Directory contents:
- `bin/`: Core executable binary.
- `config.yaml`: Generated core configuration file.
- `sash.json`: Sash settings and profile URLs.
- `state/`: PID records (`sashd.pid`, `mihomo.pid`) and install metadata.
- `logs/`: Runtime logs (`core.log`, `core.err.log`, `daemon.log`, `daemon.err.log`).
- `ui/` *(optional)*: Custom WebUI override directory.

---

## 6. Troubleshooting

- **Proxy not clearing**: Run `sash proxy off` (cleans registry / networksetup directly).
- **Inspect daemon errors**: Run `sash logs --daemon --errors`.
- **Inspect core errors**: Run `sash logs --errors`.
- **Force core update**: Run `sash update --force`.
