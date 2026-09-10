# Sash

> A lightweight command-line companion and web dashboard for a rule-based network core.

Sash is a **network toolbox for developers, learning, and research**. It installs, runs, and maintains a rule-based network core on your machine: local HTTP/SOCKS endpoints, rule-driven traffic routing, remote profile management, and live traffic inspection through a built-in web dashboard.

## Features

- **Supervisor daemon (`sashd`)** — background supervisor on port `19090` managing the core lifecycle, recovery, and reverse proxying
- **Zero-download web dashboard** — built-in modern Vue 3 dashboard bundled with the package at `http://127.0.0.1:19090/ui/`
- **Windows system proxy** — snapshots and conditionally restores the current user's prior proxy/PAC settings
- **CLI controls** — `sash start`, `stop --core`, `restart`, `profile`, `proxy`, `mode`, `status`, `logs`
- **Windows login startup** — configure it through `sash auto on/off` or the dashboard settings
- **Explicit save and apply** — import, edit and update profiles, then apply saved changes with one Core restart
- **Core updates** — automatic build selection, download integrity and rollback if the new Core fails to start (`sash update`)
- **Sash self-upgrade** — `sash upgrade` updates the CLI and dashboard, restores running instances and recovers interrupted upgrades
- **Credential hygiene** — child processes run with scrubbed environments; loopback traffic never traverses proxy dispatchers

## Requirements

- Node.js **24 or newer**
- Windows 10+ — x64 and arm64

Basic Core lifecycle and local endpoints remain portable to macOS and Linux. Desktop system-proxy and login-startup integration are Windows-only.

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
sash start                 # downloads core if needed, launches sashd and core
sash web                   # open the web dashboard (profiles, nodes, system proxy, settings)
sash status                # runtime state, endpoints, and proxy status
sash stop                  # restores prior proxy state, stops core and sashd
```

Use `sash web` to authorize and open the dashboard. Opening its address directly shows connection instructions. Refreshing an authorized tab preserves access. Normal daemon restarts need a new authorization; `sash upgrade` lets existing tabs reconnect automatically.

`sash web` also works while Core is stopped or missing. Profile selection, content edits and network settings are saved first; **Apply configuration** (or `sash restart`) restarts Core with those changes. Core updates and restarts keep the dashboard session alive.

Use `sash upgrade --check` to inspect Sash releases and `sash upgrade` to update the package and dashboard. The command restores running instances and their applied configuration while retaining unapplied edits. `sash update` updates Core. See [Updates](./docs/usage.md#updates) for compatibility, recovery and JSON output.

Use `sash auto on` to start Sash at login, `sash auto status` to inspect the
registration and `sash auto off` to remove it. This requires a direct global npm
installation and preserves the current data directory. See [Automatic Startup](./docs/autostart.md)
for platform behavior, diagnostics and removal before uninstalling.

This refactor introduces a new state format and API without migration support. Use a fresh data directory and import any profile YAML you want to keep; existing state is never silently overwritten.

## Documentation

Comprehensive documentation is available in the [`docs/`](./docs) directory:

- [**User & Operations Guide**](./docs/usage.md) — complete CLI command reference, configuration parameters and troubleshooting.
- [**PowerShell Completion**](./docs/usage.md#powershell-completion) — bundled command, option and fixed-value completion for PowerShell 7.
- [**High-level Architecture**](./docs/architecture-proposal.md) — the implemented design, ownership boundaries and save/apply flow.
- [**Automatic Startup**](./docs/autostart.md) — login startup, OS registration state and failure diagnostics.
- [**Backend Architecture**](./docs/backend.md) — supervisor daemon model (`sashd`), API endpoints, lifecycle management, system proxy adapters, and safety invariants.
- [**Frontend Architecture**](./docs/frontend.md) — built-in Vue 3 + Vite dashboard, shared API contracts, reactive runtime state, and WebSocket streaming.
- [**Third-Party Notices**](./THIRD_PARTY_NOTICES.md) — licenses and attribution for code/assets embedded in the dashboard and the runtime-downloaded Core.

## Disclaimer

Sash is a network tool created for **learning, research, and development debugging**. It runs on servers and profiles that you source and configure yourself. You are responsible for how you use it and for complying with the laws and regulations of your jurisdiction.

## Upstream Components

Sash is MIT-licensed open source and an independent project. It does not bundle the upstream Core in this repository or npm package; at runtime it downloads an unmodified release artifact from [`MetaCubeX/mihomo`](https://github.com/MetaCubeX/mihomo).

The upstream project's working source branch is [`Meta`](https://github.com/MetaCubeX/mihomo/tree/Meta), and release artifacts are published on its [releases page](https://github.com/MetaCubeX/mihomo/releases). Licensing is determined by the selected upstream release and its accompanying notices. Sash's currently tested Core contract is `v1.19.30`, whose source tag carries the [GNU General Public License v3.0](https://github.com/MetaCubeX/mihomo/blob/v1.19.30/LICENSE).

The downloaded component remains the work of its respective authors; all credit belongs upstream. See [Third-Party Notices](./THIRD_PARTY_NOTICES.md) for the bundled dashboard notices and release-specific Core attribution.
