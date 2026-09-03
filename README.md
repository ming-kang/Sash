# Sash

> A lightweight command-line companion and web dashboard for a rule-based network core.

Sash is a **network toolbox for developers and advanced users**. It installs, runs, and maintains a rule-based network core on your machine: local HTTP/SOCKS endpoints, rule-driven traffic routing, remote profile management, live traffic inspection through a built-in web dashboard, and an optional TUN mode for device-level traffic takeover.

## Features

- **Supervisor daemon (`sashd`)** — background supervisor on port `19090` managing the core lifecycle, recovery, and reverse proxying
- **Zero-download web dashboard** — built-in modern Vue 3 dashboard bundled with the package at `http://127.0.0.1:19090/ui/`
- **Reversible system proxy ownership** — snapshots and conditionally restores prior Windows, macOS, or GNOME proxy/PAC state after stop or crash
- **One-command lifecycle** — `sash start`, `stop`, `restart`, `status`, `logs`
- **Remote profiles** — fetch, validate, schedule, and hot-reload core-format network profiles from the dashboard
- **Verified upgrades** — SHA-256-verified downloads, bounded extraction, exact-version checks and atomic rollback (`sash update`)
- **TUN mode** — device-level traffic takeover (requires starting the whole Sash runtime with elevated privileges)
- **Credential hygiene** — child processes run with scrubbed environments; loopback traffic never traverses proxy dispatchers

## Requirements

- Node.js **24 or newer**
- Windows 10+, macOS, or Linux — x64 and arm64

Automatic Linux system-proxy integration currently requires a GNOME desktop with `gsettings`; Core lifecycle and local endpoints do not have that desktop requirement.

## Development Status and Source Install

Sash has not yet been published to npm. The `@astralyn/sash` package name and `npm install -g @astralyn/sash` command are reserved for the first approved release; they are not currently an installation path.

From an existing source checkout, install the current development tree with:

```sh
npm ci
npm run build
npm link
sash --help
```

`npm link` installs the locally built checkout. Remove it with `npm unlink -g @astralyn/sash` when finished.

## Quick Start

```sh
sash start                 # downloads core if needed, launches sashd and core
sash web                   # open the web dashboard (profiles, nodes, system proxy, settings)
sash status                # runtime state, endpoints, and proxy status
sash stop                  # restores prior proxy state, stops core and sashd
```

## Documentation

Comprehensive documentation is available in the [`docs/`](./docs) directory:

- [**User & Operations Guide**](./docs/usage.md) — complete CLI command reference, configuration parameters, TUN mode, and troubleshooting.
- [**Backend Architecture**](./docs/backend.md) — supervisor daemon model (`sashd`), API endpoints, lifecycle management, system proxy adapters, and safety invariants.
- [**Frontend Architecture**](./docs/frontend.md) — built-in Vue 3 + Vite dashboard, shared API contracts, reactive runtime state, and WebSocket streaming.
- [**Third-Party Notices**](./THIRD_PARTY_NOTICES.md) — licenses and attribution for code/assets embedded in the dashboard and the runtime-downloaded Core.

## Disclaimer

Sash is a network tool created for **learning, research, and development debugging**. It runs on servers and profiles that you source and configure yourself. You are responsible for how you use it and for complying with the laws and regulations of your jurisdiction.

## Upstream Components

Sash is MIT-licensed open source and an independent project. It does not bundle the upstream Core in this repository or npm package; at runtime it downloads an unmodified release artifact from [`MetaCubeX/mihomo`](https://github.com/MetaCubeX/mihomo).

The upstream project's working source branch is [`Meta`](https://github.com/MetaCubeX/mihomo/tree/Meta), and release artifacts are published on its [releases page](https://github.com/MetaCubeX/mihomo/releases). Licensing is determined by the selected upstream release and its accompanying notices. Sash's currently tested Core contract is `v1.19.30`, whose source tag carries the [GNU General Public License v3.0](https://github.com/MetaCubeX/mihomo/blob/v1.19.30/LICENSE).

The downloaded component remains the work of its respective authors; all credit belongs upstream. See [Third-Party Notices](./THIRD_PARTY_NOTICES.md) for the bundled dashboard notices and release-specific Core attribution.
