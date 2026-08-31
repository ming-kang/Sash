# Sash

> A lightweight command-line companion for a rule-based network core and its web dashboard.

Sash is a **network toolbox for developers and advanced users**. It installs, runs, and maintains a rule-based network core on your machine: local HTTP/SOCKS endpoints, rule-driven traffic routing, remote profile management, live traffic inspection through a web dashboard, and an optional TUN mode for device-level traffic takeover.

Sash is designed for developers and therefore requires professional networking knowledge to use. It runs entirely on infrastructure you control: you bring the servers and profiles, Sash brings the routing, the dashboard, and the tooling.

## Features

- **One-command lifecycle** — `sash start` / `stop` / `restart` / `status` / `logs`
- **Zero-config bootstrap** — the core binary is fetched on first run; WebUI is built-in with zero external downloads
- **Supervisor daemon (`sashd`)** — long-running supervisor process on port `19090` managing the core lifecycle and recovery
- **System proxy management** — `sash proxy on` / `off` / `status` with automatic crash reconciliation and tear-down
- **Integrated web dashboard** — served directly by `sashd` at `http://127.0.0.1:19090/ui/`; `sash web` opens it with automatic credential injection
- **Remote profiles** — point Sash at a subscription URL and it keeps the local configuration in sync (`sash sub`)
- **Safe core upgrades** — atomic binary swap with automatic rollback (`sash update`)
- **Self upgrade** — `sash upgrade` updates Sash itself via npm
- **Resilient downloads** — automatic fallback to public GitHub mirrors when direct access fails
- **TUN mode** — optional device-level traffic takeover (requires elevated privileges)
- **Credential hygiene** — the core runs with a scrubbed environment; tokens like `GITHUB_TOKEN` or npm credentials are never passed to it

## Requirements

- Node.js **20 or newer**
- Windows 10+, macOS, or Linux — x64 and arm64

## Install

```sh
npm install -g @astralyn/sash
```

## Quick start

```sh
sash start                 # first run downloads the core, launches sashd and the core
sash proxy on              # enable OS-level system proxy
sash sub set <profile>     # import a remote profile (subscription URL, native YAML format)
sash web                   # open the web dashboard
sash status                # runtime state, endpoints, and system proxy status
sash stop                  # stops core, disables system proxy, shuts down sashd
```

That's it: Sash runs a background supervisor (`sashd`) on port 19090, and the dashboard is available at `http://127.0.0.1:19090/ui/`. Use `sash web` to open it — it automatically hands credentials to the dashboard. `sash web --no-open` prints that URL instead of opening it.

## Commands

| Command | Description |
| --- | --- |
| `sash start [--no-ui]` | Install missing components and start sash in the background |
| `sash stop` | Stop sash (shuts down core and disables system proxy) |
| `sash restart [--no-ui]` | Restart the core process |
| `sash proxy on` | Route OS-level traffic through Sash |
| `sash proxy off` | Disable OS-level system proxy |
| `sash proxy status` | Show OS and desired system proxy state |
| `sash status [--json]` | Show runtime state, versions, endpoints, and proxy state |
| `sash logs [-n N] [-f] [--errors] [--daemon]` | Print runtime logs (`--daemon` for supervisor logs) |
| `sash update [--version T] [--force]` | Upgrade the core binary (atomic, with rollback) |
| `sash upgrade [--version V]` | Upgrade Sash itself via npm |
| `sash web [--no-open]` | Open the web dashboard (starts sash as needed) |
| `sash sub set <url>` | Set the remote profile URL; reloads a running core |
| `sash sub update` | Refetch the profile and hot-reload the running core |
| `sash sub show` | Show the current profile |
| `sash sub unset` | Remove the profile and revert to the default config |
| `sash config show` | Show paths and current settings |
| `sash config set <k> [v]` | Adjust managed keys (`tun`, `allow-lan`, `mixed-port`, `controller`, `secret`, `system-proxy`) |
| `sash version` | Print the Sash version |

## Settings

Sash's own settings live in `sash.json` inside the data directory; `sash config show` displays them (the secret is masked). Five keys are adjustable with `sash config set <key> [value]`:

| Key | Default | Description |
| --- | --- | --- |
| `mixed-port` | `7890` | Port of the local HTTP/SOCKS mixed listener |
| `controller` | `127.0.0.1:9090` | Listen address of the core's API controller (`host:port`; IPv6 accepted, e.g. `[::1]:9090`) |
| `secret` | *(random)* | Controller credential; auto-generated on first run, never empty |
| `tun` | `off` | Device-level traffic takeover — see TUN mode |
| `allow-lan` | `off` | Let other LAN devices use the proxy |

- All five control where or how the core listens and authenticates, so changing any of them **restarts a running core** to apply.
- With a profile configured, `config set` refetches the profile to regenerate the merged configuration, so the profile source must be reachable.
- `sash config set secret <value>` sets an explicit secret; `sash config set secret regenerate` (or omitting the value) generates a fresh random one.
- Binding `controller` to a wildcard address (`0.0.0.0`, `::`) is accepted; `sash web` maps it to the matching loopback address, since a wildcard is a listen target, not a connect target. Note this also exposes the API to the LAN — it stays protected by `secret`.
- `sash.json` may be hand-edited while the core is stopped (writes are atomic and owner-only on POSIX), but `config set` is the supported path: it validates values and applies them.

## Profiles

A profile is a remote YAML document in the core's native format (endpoints, groups, and rules), fetched over http(s). Sash fetches it, merges it with its own operational settings, and writes the result as the core's configuration file. Documents that are not valid profiles (base64 blobs, share-link lists, YAML without `proxies` or `rules`) are rejected — convert them first, e.g. with a subconverter.

**Sash owns the operational keys.** Profile values for `mixed-port`, `port`, `socks-port`, `external-controller`, `external-ui*`, `secret`, `tun`, and `allow-lan` are discarded and replaced with your Sash settings — adjust them with `sash config set`, not in the profile. Everything else (proxies, groups, rules, dns, sniffer) passes through untouched.

`sash sub set`, `sub unset`, and `sub update` take effect immediately: a running core is hot-reloaded in place, without a restart.

## TUN mode

```sh
sash config set tun on
sash restart
```

TUN creates a virtual network interface to take over device traffic, so the core must run with elevated privileges: use an Administrator terminal on Windows, or root/sudo on macOS and Linux. The generated TUN configuration is fixed (stack `mixed`, auto-route, dns-hijack), and `tun:` sections in profiles are ignored — TUN can only ever be enabled explicitly through `sash config`.

## Data directory

| Platform | Location |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Sash` |
| macOS | `~/Library/Application Support/Sash` |
| Linux | `$XDG_DATA_HOME/sash` or `~/.local/share/sash` |

Override with the `SASH_HOME` environment variable (absolute path). The directory holds the core binary, configuration, dashboard assets, logs, and state — everything Sash needs, in one place.

## Troubleshooting

- `sash logs` prints the core's stdout log, `sash logs --errors` its stderr log; add `-f` to follow. Both live under `logs/` in the data directory.
- `sash status` shows whether the core is alive and the controller answers.
- `sash stop` verifies the recorded process's identity before terminating it and refuses when verification is impossible, keeping the pid record rather than killing an unrelated process. If you hit this: inspect the process yourself; if it is not Sash's core, delete `state/sash.pid` in the data directory — otherwise terminate it manually.
- Dashboard installation is best-effort: if the download fails, the core still proxies traffic, just without the web UI. Re-run `sash web` to retry; `sash status` shows whether the dashboard is installed.
- On CPUs without x86-64-v3 support, the default amd64 core build crashes (`illegal instruction`). Replace the binary under `bin/` in the data directory with the `-compatible` build of the same version from the core's release page (`state/install.json` records the installed version).

## Uninstall

```sh
npm uninstall -g @astralyn/sash
```

Then delete the data directory (see the table above) to remove the core, dashboard, configuration, and logs.

## Resilient downloads

Release downloads try the direct upstream channel first and automatically fall back to public GitHub mirrors (`ghfast.top`, `gh-proxy.com`). If the GitHub API is rate-limited, set `GITHUB_TOKEN` or `GH_TOKEN`. Standard `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (and `ALL_PROXY`) environment variables are honoured for remote downloads; local controller traffic always goes direct.

## Disclaimer

Sash is a network tool created for **learning, research, and development debugging**. It runs on servers and profiles that you source and configure yourself. You are responsible for how you use it and for complying with the laws and regulations of your jurisdiction.

## Upstream components

Sash itself is MIT-licensed open source and an independent project. On first run it downloads the unmodified upstream network core binary, published under the MIT license by its authors:

- the network core: [`MetaCubeX/mihomo`](https://github.com/MetaCubeX/mihomo)

The component remains the work of its respective authors; all credit belongs upstream.
