# Sash User & Operations Guide

Sash is a network toolbox for developers, learning and research. Use the CLI for commands and the built-in dashboard for profiles, settings and live traffic. Node.js 24 or newer is required; Windows is the primary desktop platform.

[Backend architecture](./backend.md) · [Frontend architecture](./frontend.md) · [Start at login](./autostart.md)

## Mental model

Sash keeps a **saved** configuration and a **running** one. Selecting, editing or updating the selected profile applies to a running Core immediately — the reload swaps proxies and rules in place, so established connections survive. Only proxy-port, LAN-access and effective TUN changes wait for **Apply configuration** or `sash restart`, which restarts Core. Effective TUN changes are enable flips or, while TUN is enabled, edits to TUN settings that reach the running configuration. `sash status` reports both sides: what is saved and what Core is actually using.

Validation happens before anything is touched. A rejected configuration leaves the running Core and your saved edits intact, so the dashboard stays usable for correction.

## Commands

Bare `sash` reads status once. `sash <command> --help` lists every option; `--json` is available throughout for scripting.

- Lifecycle: `start`, `restart` (apply saved settings), `stop` (`--core` keeps Sash up), `web` (open the dashboard), `status` (`--watch`, `--verbose`, `--delay <node>`), `doctor`, `logs`.
- Profiles: `sash profile list | use | add | update | rename | remove`. A profile argument is its full ID or a unique exact name. `update --all` continues past failures and exits `1` with per-profile errors.
- Runtime: `mode rule|global|direct`, `proxy on|off|status` (Windows system proxy), `tun`, `auto` (start at login).
- Downloads: `update` (Core) and `upgrade` (Sash itself) are daemon-owned: closing the terminal leaves them running, and `status` reports progress. Ctrl+C on `update`/`start`/`restart` cancels a running download (exit 130); `sash update --cancel` does the same from another terminal. Only one Core download runs at a time.

Typical flow:

```sh
sash web                       # import a profile in the dashboard, or:
sash profile add <url> --use   # ...from the CLI
sash proxy on                  # needs a healthy Core
```

## TUN Mode

TUN Mode lets Core capture traffic through a virtual network interface instead of the proxy port. Creating the interface needs administrator privilege, which Sash obtains once per data folder:

```sh
sash tun helper install   # one administrator prompt
sash tun on
sash restart
```

| Platform | What `helper install` does | After `sash update` |
| --- | --- | --- |
| Windows | Installs the `SashTun` service — downloaded from this Sash version's GitHub Release — which runs Core as LocalSystem | Nothing |
| macOS | setuid root on the Core executable | Run `helper install` again |
| Linux | `cap_net_admin,cap_net_bind_service` on the Core executable (pkexec, or `SASH_TUN_HELPER_AUTH=sudo`; a successful sudo choice is reused until `SASH_TUN_HELPER_AUTH=pkexec` is used once) | Run `helper install` again |

`sash tun helper status` reports a helper serving another data folder or an older protocol; `install` replaces it, `uninstall` removes the grant (disable TUN first). A TUN Core that fails to start rolls back to the previous configuration.

The helper grants privilege to a Core inside your data folder — anything running as your account can use that Core with the same privilege. Uninstall it when TUN is not needed.

## Browser access

`sash web` opens `http://127.0.0.1:<daemonPort>/ui/` with no sign-in; bookmark it freely. Sash accepts control requests only from pages it serves — the browser marks every request with its origin, so other sites and other local web apps, even on another loopback port, cannot change settings or read private data. Local programs and other accounts on this machine are inside the trust boundary; the CLI authenticates with the daemon secret in `sash.json`.

## PowerShell completion

```powershell
. (Join-Path (npm root --global) '@astralyn/sash/docs/completions/sash.ps1')   # add to $PROFILE to keep
```

## Data folder

| Platform | Default |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Sash` |
| macOS | `~/Library/Application Support/Sash` |
| Linux | `$XDG_DATA_HOME/sash` or `~/.local/share/sash` |

An absolute `SASH_HOME` selects another folder; use a local filesystem with atomic rename and hard-link support. Profile sources live in `profiles/`, the generated core config in `runtime/`, binaries in `bin/`, runtime records in `state/`, logs in `logs/`.

`sash.json` is the saved state (`schemaVersion: 2`, `settings`, `profiles`). Edit it only while Sash is stopped: the three ports must differ, the controller must be loopback, credentials nonblank.

## Updates

### Core

```sh
sash update --check   # release metadata only; does not need Sash or Core running
sash update           # latest release
sash update v1.19.30  # exact tag
```

The release is resolved before anything downloads, so asking for the installed version downloads nothing. The archive is checked against the release API's SHA-256 while streaming, the previous binary survives until the new Core passes a health check, and failure restores it. An update while stopped starts Core briefly for verification, then stops it again.

`SASH_CORE_VERSION` pins a tag. When the release API is unreachable, the bootstrap manifest packaged with this release still supplies the pinned tag's metadata and digests; pinning any other tag still needs the API.

Downloads use, in order: a proxy variable Sash inherited at startup (`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`), Sash's own running Core, then direct with the release mirrors (`ghfast.top`, `gh-proxy.com`). Variables set in a later terminal only affect the CLI reading them (`update --check`, `doctor`), never the daemon's download. A loopback proxy that refuses the connection is retried directly once. `sash status --verbose` shows the choice on the `Download Via` line.

### Install Core offline

For machines that reach neither GitHub nor the mirrors:

1. Download the Core archive from `MetaCubeX/mihomo` releases, and geodata from `MetaCubeX/meta-rules-dat` if profiles use GeoIP/GeoSite rules.
2. Stop Sash; place the executable at `bin/mihomo.exe` (Windows) or `bin/mihomo` in the data folder.
3. Write `state/install.json` recording the tag, e.g. `{"coreVersion": "v1.19.30"}`. Without it Sash reports the install incomplete; a mismatched tag fails health checks honestly.
4. Put geodata files (`geoip.metadb`, `geosite.dat`, `country.mmdb`, `GeoLite2-ASN.mmdb`) in the data-folder root.
5. `sash start`, then `sash doctor`.

A stale `HTTP_PROXY` pointing at a dead loopback port breaks these downloads — Sash warns and retries directly.

### Sash package

```sh
sash upgrade --check
sash upgrade   # npm installs while Sash runs, then Sash restarts
sash start     # resume Core after the restart
```

The target is npm `latest` or an exact version, so upgrades and downgrades work the same. Requires a direct global install; source checkouts and other package managers report why they are unsupported. `--no-restart` installs without restarting. A failed install leaves the running instance alone. Manual path: `npm install -g @astralyn/sash`, then `sash stop && sash start`.

## Status and troubleshooting

`sash doctor` checks installation, files, ports and Windows integration — start there for problems. `sash status --verbose` adds the applied profile, installed/running versions, download transport and config paths; `--watch` follows changes and survives Sash restarts. `sash status --delay <node>` runs an explicit latency probe; naming a group tests its selected outbound.

`System Proxy` reports the observed Windows setting — a mismatch with Sash's saved preference warns rather than hides. Turning it off restores the previous Windows values, which may themselves enable another proxy. Desktop proxy and login startup are Windows-only; `doctor` may report VPN/dial-up proxy records Sash does not manage.

Geodata failures: Core downloads databases itself, ignoring `HTTP_PROXY`; Sash then tries the mirrors, then fetches them through the verified release pipeline. If all fail, seed the files manually (offline install above) or set a reachable `geox-url` in the profile.

`SASH_DEBUG=1` prints CLI error stacks to stderr.
