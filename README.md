# Sash

> A lightweight command-line companion and web dashboard for a rule-based network core.

Sash is a **network toolbox for developers and advanced users**. It installs, runs, and maintains a rule-based network core on your machine: local HTTP/SOCKS endpoints, rule-driven traffic routing, remote profile management, live traffic inspection through a built-in web dashboard, and an optional TUN mode for device-level traffic takeover.

## Features

- **Supervisor daemon (`sashd`)** — background supervisor on port `19090` managing the core lifecycle, recovery, and reverse proxying
- **Zero-download web dashboard** — built-in modern Vue 3 dashboard bundled with the package at `http://127.0.0.1:19090/ui/`
- **Reversible system proxy ownership** — snapshots and conditionally restores prior Windows, macOS, or GNOME proxy/PAC state after stop or crash
- **One-command lifecycle** — `sash start`, `stop`, `restart`, `status`, `logs`
- **Remote profiles** — fetch, validate, schedule, and hot-reload core-format network profiles (`sash sub`)
- **Verified upgrades** — SHA-256-verified downloads, bounded extraction, exact-version checks and atomic rollback (`sash update`)
- **TUN mode** — device-level traffic takeover (requires starting the whole Sash runtime with elevated privileges)
- **Credential hygiene** — child processes run with scrubbed environments; loopback traffic never traverses proxy dispatchers

## Requirements

- Node.js **24 or newer**
- Windows 10+, macOS, or Linux — x64 and arm64

Automatic Linux system-proxy integration currently requires a GNOME desktop with `gsettings`; Core lifecycle and local endpoints do not have that desktop requirement.

## Install

```sh
npm install -g @astralyn/sash
```

## Quick Start

```sh
sash start                 # downloads core if needed, launches sashd and core
sash proxy on              # take ownership of OS proxy state
sash sub set <url>         # download and activate a remote profile
sash web                   # open the web dashboard
sash status                # runtime state, endpoints, and proxy status
sash stop                  # restores prior proxy state, stops core and sashd
```

## Documentation

Comprehensive documentation is available in the [`docs/`](./docs) directory:

- [**User & Operations Guide**](./docs/usage.md) — complete CLI command reference, configuration parameters, TUN mode, and troubleshooting.
- [**Backend Architecture**](./docs/backend.md) — supervisor daemon model (`sashd`), API endpoints, lifecycle management, system proxy adapters, and safety invariants.
- [**Frontend Architecture**](./docs/frontend.md) — built-in Vue 3 + Vite dashboard, shared API contracts, reactive runtime state, and WebSocket streaming.

## Disclaimer

Sash is a network tool created for **learning, research, and development debugging**. It runs on servers and profiles that you source and configure yourself. You are responsible for how you use it and for complying with the laws and regulations of your jurisdiction.

## Upstream Components

Sash is MIT-licensed open source and an independent project. On first run it downloads the unmodified upstream network core binary, published under the MIT license by its authors:

- the network core: [`MetaCubeX/mihomo`](https://github.com/MetaCubeX/mihomo)

The component remains the work of its respective authors; all credit belongs upstream.
