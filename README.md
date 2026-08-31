# Sash

> A lightweight command-line companion and web dashboard for a rule-based network core.

Sash is a **network toolbox for developers and advanced users**. It installs, runs, and maintains a rule-based network core on your machine: local HTTP/SOCKS endpoints, rule-driven traffic routing, remote profile management, live traffic inspection through a built-in web dashboard, and an optional TUN mode for device-level traffic takeover.

## Features

- **Supervisor daemon (`sashd`)** — background supervisor on port `19090` managing the core lifecycle, recovery, and reverse proxying
- **Zero-download web dashboard** — built-in modern Vue 3 dashboard bundled with the package at `http://127.0.0.1:19090/ui/`
- **System proxy management** — native Windows, macOS, and Linux system proxy toggling with automatic crash reconciliation
- **One-command lifecycle** — `sash start`, `stop`, `restart`, `status`, `logs`
- **Remote profiles** — fetch, validate, and hot-reload remote Clash/mihomo-format subscription profiles (`sash sub`)
- **Safe upgrades** — atomic core binary swap with rollback (`sash update`) and npm self-upgrade (`sash upgrade`)
- **TUN mode** — device-level traffic takeover (requires elevated privileges)
- **Credential hygiene** — child processes run with scrubbed environments; loopback traffic never traverses proxy dispatchers

## Requirements

- Node.js **20 or newer**
- Windows 10+, macOS, or Linux — x64 and arm64

## Install

```sh
npm install -g @astralyn/sash
```

## Quick Start

```sh
sash start                 # downloads core if needed, launches sashd and core
sash proxy on              # enable OS-level system proxy
sash sub set <profile>     # import a remote subscription profile
sash web                   # open the web dashboard
sash status                # runtime state, endpoints, and proxy status
sash stop                  # stops core, disables system proxy, shuts down sashd
```

## Documentation

Comprehensive documentation is available in the [`docs/`](./docs) directory:

- [**User & Operations Guide**](./docs/usage.md) — complete CLI command reference, configuration parameters, TUN mode, and troubleshooting.
- [**Backend Architecture**](./docs/backend.md) — supervisor daemon model (`sashd`), API endpoints, lifecycle management, system proxy adapters, and safety invariants.
- [**Frontend Architecture**](./docs/frontend.md) — built-in Vue 3 + Vite dashboard, Slate/Sky theme system, reactive state, and WebSocket streaming.

## Disclaimer

Sash is a network tool created for **learning, research, and development debugging**. It runs on servers and profiles that you source and configure yourself. You are responsible for how you use it and for complying with the laws and regulations of your jurisdiction.

## Upstream Components

Sash is MIT-licensed open source and an independent project. On first run it downloads the unmodified upstream network core binary, published under the MIT license by its authors:

- the network core: [`MetaCubeX/mihomo`](https://github.com/MetaCubeX/mihomo)

The component remains the work of its respective authors; all credit belongs upstream.
