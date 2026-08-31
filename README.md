# Sash

> A lightweight command-line companion for a rule-based network core and its web dashboard.

Sash is a **network toolbox for developers and advanced users**. It installs, runs, and maintains a rule-based network core on your machine: local HTTP/SOCKS endpoints, rule-driven traffic routing, remote profile management, live traffic inspection through a web dashboard, and an optional TUN mode for device-level traffic takeover.

Sash is designed for developers and therefore requires professional networking knowledge to use. **Sash does not provide any proxy or VPN service, nor any server resources of any kind — you need to configure your own servers and profiles.**

## Features

- **One-command lifecycle** — `sash start` / `stop` / `restart` / `status` / `logs`
- **Zero-config bootstrap** — the core and dashboard are fetched on first run; no manual downloads
- **Integrated web dashboard** — served by the core itself, no extra port or process
- **Remote profiles** — point Sash at a subscription/profile URL and it keeps the local configuration in sync (`sash sub`)
- **Safe core upgrades** — atomic binary swap with automatic rollback (`sash update`)
- **Self upgrade** — `sash upgrade` updates Sash itself via npm
- **Resilient downloads** — automatic fallback to public GitHub mirrors when direct access fails
- **TUN mode** — optional device-level traffic takeover (requires elevated privileges)

## Requirements

- Node.js **20 or newer**
- Windows 10+, macOS, or Linux — x64 and arm64

## Install

```sh
npm install -g @astralyn/sash
```

## Quick start

```sh
sash start                 # first run downloads the core and dashboard, then launches
sash sub set <profile>     # import a remote profile (subscription URL, native YAML format)
sash ui                    # open the web dashboard
sash status                # runtime state and endpoints
sash stop
```

That's it: the core runs as a detached background process, and the dashboard is available at the address printed by `sash status` (default `http://127.0.0.1:9090/ui`).

## Commands

| Command | Description |
| --- | --- |
| `sash start [--no-ui]` | Install missing components and start the core |
| `sash stop` | Stop the running core |
| `sash restart` | Restart the core |
| `sash status [--json]` | Show runtime state, versions, and endpoints |
| `sash logs [-n N] [-f]` | Print (or follow) core logs |
| `sash update [--version T] [--force]` | Upgrade the core binary (atomic, with rollback) |
| `sash upgrade` | Upgrade Sash itself via npm |
| `sash ui [--no-open]` | Open the web dashboard (starts components as needed) |
| `sash sub set <url>` | Set the remote profile URL and regenerate the config |
| `sash sub update` | Refetch the profile and hot-reload the running core |
| `sash sub show` / `unset` | Show or remove the current profile |
| `sash config show` | Show paths and current settings |
| `sash config set <k> [v]` | Adjust `tun`, `allow-lan`, `mixed-port`, `controller`, `secret` |

## Profiles

A profile is a remote YAML document in the core's native format (endpoints, groups, and rules). Sash fetches it, merges it with its own operational settings (ports, controller, dashboard, TUN), and writes the result as the core's configuration file. Profiles in other formats must be converted first.

## TUN mode

```sh
sash config set tun on
sash restart
```

TUN creates a virtual network interface to take over device traffic, so the core must run with elevated privileges: use an Administrator terminal on Windows, or root/sudo on macOS and Linux.

## Data directory

| Platform | Location |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Sash` |
| macOS | `~/Library/Application Support/Sash` |
| Linux | `$XDG_DATA_HOME/sash` or `~/.local/share/sash` |

Override with the `SASH_HOME` environment variable (absolute path). The directory holds the core binary, configuration, dashboard assets, logs, and state — everything Sash needs, in one place.

## Resilient downloads

Release downloads try the direct upstream channel first and automatically fall back to public GitHub mirrors (`ghfast.top`, `gh-proxy.com`). If the GitHub API is rate-limited, set `GITHUB_TOKEN` or `GH_TOKEN`. Standard `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (and `ALL_PROXY`) environment variables are honoured for remote downloads; local controller traffic always goes direct.

## Disclaimer

Sash is a network tool created for **learning, research, and development debugging**. It provides no proxy or VPN service and no server-side resources. You are solely responsible for how you configure and use it, and for complying with the laws and regulations of your jurisdiction.

## Upstream components

Sash itself is MIT-licensed open source and an independent project. On first run it downloads two unmodified upstream components, each published under the MIT license by their respective authors:

- the network core: [`MetaCubeX/mihomo`](https://github.com/MetaCubeX/mihomo)
- the web dashboard: [`MetaCubeX/metacubexd`](https://github.com/MetaCubeX/metacubexd)

Sash is not affiliated with, sponsored by, or endorsed by MetaCubeX.
