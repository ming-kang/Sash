# Sash

> A lightweight command-line companion and web dashboard for a rule-based network core.

Sash is a **network toolbox for developers, learning, and research**. It installs, runs, and maintains a rule-based network core on your machine: local HTTP/SOCKS endpoints, rule-driven traffic routing, remote profile management, and live traffic inspection through a built-in web dashboard.

## Features

- **Background supervisor** — one Sash process per data folder on port `19090`, managing the Core lifecycle, recovery and reverse proxying
- **Zero-download web dashboard** — built-in Vue 3 dashboard bundled with the package at `http://127.0.0.1:19090/ui/`
- **Explicit save and apply** — import, edit and update profiles, then apply saved changes with one Core restart
- **Windows desktop integration** — system proxy with snapshot and conditional restore, plus start at login (`sash auto`)
- **Verified updates** — integrity-checked Core downloads with rollback (`sash update`); `sash upgrade` installs a new Sash through npm and restarts it
- **Diagnostics** — `sash doctor [--json]` checks installation, state, ports and Windows integration, with repair advice
- **Credential hygiene** — child processes run with scrubbed environments; loopback traffic never traverses proxy dispatchers

## Requirements

- Node.js **24 or newer**
- Windows 10+ — x64 and arm64

Core lifecycle and local endpoints are portable to macOS and Linux; system-proxy and login-startup integration are Windows-only.

## Install

```sh
npm install -g @astralyn/sash
sash --help
```

From a source checkout instead:

```sh
npm ci
npm run build
npm link
sash --help
```

`npm link` installs the locally built checkout. Remove it with `npm unlink -g @astralyn/sash` when finished.

## Quick Start

```sh
sash start                 # downloads Core if needed, launches Sash and Core
sash web                   # open and authorize the web dashboard
sash status                # runtime state, endpoints, and proxy status
sash stop                  # restores prior proxy state, stops Core and Sash
```

The dashboard also works while Core is stopped: edits are saved first, then **Apply configuration** (or `sash restart`) restarts Core with them. See the [User & Operations Guide](./docs/usage.md) for all commands, updates and troubleshooting, and [Automatic Startup](./docs/autostart.md) for `sash auto on`.

## Documentation

- [**User & Operations Guide**](./docs/usage.md) — CLI command reference, configuration, updates and troubleshooting.
- [**Automatic Startup**](./docs/autostart.md) — login startup, registration state and diagnostics.
- [**Backend Architecture**](./docs/backend.md) — background process, local API, lifecycle and safety invariants.
- [**Frontend Architecture**](./docs/frontend.md) — Vue 3 dashboard, shared state, API contracts and streaming.
- [**Third-Party Notices**](./THIRD_PARTY_NOTICES.md) — licenses for bundled dashboard assets and the runtime-downloaded Core.

## Disclaimer

Sash is a network tool created for **learning, research, and development debugging**. It runs on servers and profiles that you source and configure yourself. You are responsible for how you use it and for complying with the laws and regulations of your jurisdiction.

## Upstream Components

Sash is MIT-licensed open source and an independent project. It does not bundle the upstream Core in this repository or npm package; at runtime it downloads an unmodified release artifact from [`MetaCubeX/mihomo`](https://github.com/MetaCubeX/mihomo). The upstream working source branch is [`Meta`](https://github.com/MetaCubeX/mihomo/tree/Meta); licensing is determined by the selected release and its accompanying notices. Sash's currently tested Core contract is `v1.19.30`, whose source tag carries the [GNU General Public License v3.0](https://github.com/MetaCubeX/mihomo/blob/v1.19.30/LICENSE).

The downloaded component remains the work of its respective authors; all credit belongs upstream. See [Third-Party Notices](./THIRD_PARTY_NOTICES.md) for bundled dashboard notices and release-specific Core attribution.
