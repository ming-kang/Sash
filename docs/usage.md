# Sash User & Operations Guide

Sash is a lightweight network toolbox for developers, learning and research, with a CLI and built-in web dashboard. Windows is the primary desktop platform.

## Start and configure

```sh
sash web         # start management and authorize the browser; Core stays stopped
sash start       # install Core if missing, apply saved configuration and start
sash status
sash stop        # restore the prior proxy, stop Core and exit the daemon
```

In **Profiles**, import YAML or download a remote profile, then select it. Selection, content edits, downloads and scheduled updates are saved without changing the running Core. Click **Apply configuration** to use the saved configuration. This restarts Core and briefly interrupts connections. Overview shows the profile and port actually applied.

If validation fails, the previous Core keeps running. If starting the new configuration fails, your saved edits remain and the dashboard stays available for correction. There is no automatic rollback of saved edits.

## Commands

| Command | Behavior |
| --- | --- |
| `sash start` | Ensure management exists; start with saved configuration if stopped. Report an already-running Core separately, using its actual applied port. |
| `sash restart` | Apply saved configuration and restart Core; keep the daemon and browser sessions. |
| `sash stop` | Restore proxy, stop Core and exit management. Report an error if safe shutdown cannot be verified. |
| `sash stop --core` | Restore proxy and stop Core while retaining management and browser access. |
| `sash status [--json] [--watch] [--delay NAME]` | Read runtime, endpoint, saved profile, proxy and autostart observations; optionally follow changes or explicitly test one outbound. Bare `sash` reads once. |
| `sash doctor [--json]` | Check installation, dashboard, saved state, Core files, ports and desktop integration; print repair suggestions. |
| `sash web` | Start management if needed and authorize/open the dashboard. |
| `sash web --no-open` | Start management and print its address without authorizing a browser. |
| `sash update [tag] [--check] [--json]` | Check a Core release or install it through the daemon, with preparation/download/verification progress. |
| `sash upgrade [version] [--check] [--json]` | Update the Sash package through npm and restart the management daemon. |
| `sash profile [list]` | List saved profiles; `list --json` returns their metadata and saved selection. |
| `sash profile use <profile>` / `use --default` | Select an ID or unique exact name, or the built-in configuration, for the next Apply. |
| `sash profile add <url> [--name NAME] [--use]` | Download and save a remote profile; the first profile is selected automatically. |
| `sash profile update [profile] [--all]` | Update the specified or selected remote profile, or all remote profiles. |
| `sash profile rename <profile> <name>` / `remove <profile>` | Rename or remove the saved profile identified by ID or exact name. |
| `sash proxy [on\|off\|status] [--json]` | Set system-proxy intent or inspect desired, Sash-applied and OS-observed state. |
| `sash mode rule\|global\|direct [--json]` | Change the running Core's mode; the next Apply restores the saved profile's mode. |
| `sash auto [on\|off\|status] [--json]` | Set or inspect Windows login startup. No argument means status; changes report when they start management. |
| `sash logs [-n N] [-f] [--errors] [--daemon]` | Read Core or daemon logs; follow waits for creation and handles rotation. |
| `sash logs --startup [-n N] [-f]` | Read login attempts, including settings errors before daemon startup. |
| `sash version` | Print the package version. |

`sash logs -f` exits successfully when its output pipe closes. Log capture and follow share one file position, including when the log grows or rotates during startup.

`sash stop --core` and WebUI **Stop Core** keep the management process open. `sash upgrade` stops management, installs the new Sash package through npm and starts management again. `restart` applies saved configuration to Core.

## PowerShell completion

Load the bundled completion script in PowerShell 7:

```powershell
. (Join-Path (npm root --global) '@astralyn/sash/docs/completions/sash.ps1')
```

Add the same line to `$PROFILE` to load it in future sessions. From a source checkout, dot-source `./docs/completions/sash.ps1` instead. The script completes commands, profile subcommands, options and fixed choices such as `mode rule|global|direct`. It handles quoted arguments, option values and the cursor position without running Sash, starting management or accessing the network. Enter profile/node names, URLs and version numbers normally.

## Browser access

Run `sash web` as the same user and with the same `SASH_HOME` as the instance. A private local handoff authorizes the browser without printing credentials. It expires after 90 seconds and works once; rerun the command if needed.

An authorized tab survives refresh, Core restarts/updates and management restarts, including `sash stop` + `sash start`, `sash restart` and `sash upgrade`; the daemon exchanges the previous generation's session for a new one. Sessions expire after twelve idle hours and renew while used. If browser storage is disabled, authorization lasts only for the current page. Opening a bare dashboard address displays connection instructions.

## Settings and profiles

Profile commands accept a complete ID or a unique exact display name. Use the ID when names collide. They save changes through management without applying them to Core. `sash profile list` also works while management is stopped and does not initialize a missing data directory. All profile subcommands support `--json`; a partially failed `update --all` returns exit code `1` and per-profile errors.

```sh
sash profile add https://example.com/profile.yaml --name Work --use
sash profile list
sash profile update Work
sash restart               # apply the saved selection, content and network settings
sash mode global           # change only the running routing mode
sash proxy on              # requires a healthy running Core
```

The Settings page saves the mixed proxy port and LAN access for the next Apply. The system-proxy switch takes effect separately and requires a healthy Core to enable. A failed disable keeps the saved off intent; retry it after resolving the OS problem.

Remote profiles use the provider's update interval, defaulting to 24 hours. The daemon checks for due updates every 15 minutes. Updates save new content and indicate pending Apply. Identical content does not create a new content revision. Rename and reorder do not affect running data or latency results.

Subscriptions must contain core-format YAML; a document that is not an object, including a share-link list, receives a format error. Sash does not convert subscription formats. Empty quota/expiry fields remain unknown, while explicit zero values are retained.

The profile editor rejects a save if another edit changed its content revision. Reopen the current content before retrying. The raw application settings file has no online editor.

Login startup is managed through the OS registration, not a boolean in the settings file. Enabling it requires a direct global npm installation. See [Automatic Startup](./autostart.md).

## State format and data

This branch requires a new schema-2 manifest and provides no migration from older releases. Stop the old instance using its existing installation, keep any profile YAML you need, then use a fresh data directory and import those files normally. Old state is never silently overwritten.

`sash.json` contains `{schemaVersion: 2, revision, settings, profiles}`. `profiles` contains the saved `activeId` and metadata list. The following keys live inside `settings`:

| Key | Initial value | Meaning |
| --- | --- | --- |
| `mixedPort` | `7890` | HTTP/SOCKS mixed proxy port |
| `allowLan` | `false` | Accept proxy traffic from other devices |
| `systemProxy` | `false` | Desired Windows system-proxy state |
| `controller` | `127.0.0.1:9090` | Internal loopback controller address |
| `daemonPort` | `19090` | Management API and dashboard port |
| `secret` | random | Private controller credential |
| `daemonSecret` | random | Private CLI credential |

Controller/daemon addresses and credentials can be edited only while Sash is stopped, then read at daemon startup. All three ports must differ. Secrets cannot be blank. Invalid, unknown-field, oversized or unsupported-format state is rejected intact. There are no TUN or legacy subscription settings.

| Platform | Default directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Sash` |
| macOS | `~/Library/Application Support/Sash` |
| Linux | `$XDG_DATA_HOME/sash` or `~/.local/share/sash` |

Use an absolute `SASH_HOME` to select another directory. Use a local filesystem supporting atomic rename and hard links.

```text
sash.json                       settings, profiles, selection and saved-state revision
profiles/<id>/<revision>.yaml    immutable source content
runtime/config.yaml             generated runtime configuration
bin/                            Core executable and temporary update backup
state/install.json              installed Core version
state/core-update-transaction.json  active binary update/recovery
state/web-sessions.json         hashed browser sessions
state/system-proxy.json         original proxy snapshot and recovery phase
state/sash.pid, state/sashd.pid  process discovery records
state/sashd*.lock               daemon singleton/startup ownership
logs/                           Core, daemon and login diagnostics
ui/                             optional custom dashboard override
```

On Windows, the browser session file sits directly in the per-user control directory (`%LOCALAPPDATA%\Sash`); elsewhere it stays in `<data directory>/state`. It is independent of `SASH_HOME` and holds only session hashes.

The manifest and sources use atomic publication. Old source revisions may be cleaned after successful saves; this is not a version-history feature. Do not edit generated runtime configuration. POSIX private state/logs use `0600`.

While management is running, scheduled maintenance removes recognized orphan revisions and temporary files older than 24 hours. Current sources, recent files, unknown names and symbolic links are preserved. Empty generated directories also have a 24-hour grace period. Core preparation files are protected while a download is active.

## Updates

```sh
sash update --check         # inspect Core release metadata without starting management
sash update                # install the latest Core release with progress
sash update v1.19.30        # select an exact Core release tag
sash update --json         # one JSON result, without progress text
```

The Core tag is a positional argument; the former `sash update --version TAG` option is replaced. Global `sash --version` prints the Sash package version. `--check` reads the recorded Core version and official release metadata, verifies a compatible artifact and digest are available, and does not download or install the binary. Updates show their current stage and downloaded bytes; JSON mode suppresses these messages.

Core updates keep the dashboard available and preserve whether Core was running. Even an initially stopped update performs a temporary startup/health check, then stops again. `.bak` is retained until the new binary passes verification and the original running state is restored. Failure rolls back the executable and install record; saved profiles/settings are not part of this transaction.

Downloads use trusted HTTPS origins, one archive integrity check during transfer, and bounded extraction. A failed download leaves the current installation available. Startup, restart and doctor do not hash installed Core files. Older install records need no digest migration or background download.

On x64, installation and updates select the highest supported official build: v3, v2 or v1. Detection includes operating-system support for vector instructions. Windows uses PowerShell 7 when available; unavailable detection falls back to compatible/v1 builds. ARM64 uses its native build. The chosen asset name is saved for new installations and updates.

A first `sash start` downloads and starts Core once. Its controller readiness check supplies the running version; successful readiness ends the check.

Update Sash itself:

```sh
sash upgrade --check       # inspect the npm release and Node compatibility
sash upgrade               # install the target version and restart the daemon
sash upgrade --json        # one JSON object; npm output stays on stderr
```

The default target is the official npm `latest` release. An optional exact published version selects an upgrade or downgrade; `available` is true for an explicit version that differs from the installed one, and for `latest` when it is newer. An already-current version exits successfully. `--check` leaves the installation and data directories unchanged and never starts management. Source checkouts, linked packages and other package managers report `supported: false` with the reason and never contact the registry; they exit `1` without `--check`.

Execution resolves the target, stops the daemon if it is running, runs `npm install --global --prefix <prefix> --no-audit --no-fund @astralyn/sash@<version>` with the Node executable, the resolved npm CLI, no shell and a scrubbed environment, then starts the daemon again only if it had been running. Stopping management also stops Core and restores the prior system proxy, and the restarted daemon leaves Core stopped: run `sash start` to resume traffic. Browser authorization continues across the restart. npm owns package integrity; if npm fails, the daemon is started again on the previously installed version and the npm error is reported.

`--check --json` prints the inspection report: `current`, `target`, `available`, `compatible`, `supported`, `installation`, `prefix`, `node`, `requiredNode` and `reason`. Execution `--json` prints one object instead: `{outcome: "upgraded", version}` after a successful install, `{outcome: "failed", error}` on failure, or the report plus `outcome: "current"`, `"unsupported"` or `"incompatible"` when nothing was installed. Exit code `0` means a successful check, no-op or install; `1` means an unsupported or incompatible installation, or a failure.

For manual package-manager maintenance, stop Sash first, update with that package manager, then start it again so the daemon runs the new code. `sash update --force` is unavailable. Damaged Core installations are diagnosed and preserved; stop the existing instance before using a clean data directory for reinstallation.

## Status and troubleshooting

Run `sash doctor` before changing a damaged installation. Checks continue independently when the manifest or Core files are invalid. Doctor reads installation metadata and file information, observes the current runtime and desktop integration, and briefly checks whether stopped listener ports are available. It does not hash executables, initialize state, install components, start management or apply repairs.

`doctor --json` reports `schemaVersion: 1`, `healthy`, `complete`, and named checks with `ok`, `info`, `warning` or `error` status and optional advice. Exit code `1` indicates a definite fault; `2` indicates an incomplete observation without a definite fault. A clean stopped or uninitialized installation can return `0` with informational setup guidance.

On Windows, doctor checks for additional connection-specific proxy records, such as VPN/dial-up registrations. These may include inactive records; their presence does not prove that a connection is active. Sash manages desktop LAN proxy/PAC settings and does not decode or change the per-connection binary records. A warning asks you to inspect those settings in Windows; unavailable registry observations remain unknown.

`sash status --json` uses `schemaVersion: 2`. It includes `complete`, `healthy`, `queryError`, daemon/Core state, desired/applied/observed proxy state, autostart, endpoints, saved active profile and paths. Unknown observations remain `null`; no TUN fields are emitted. The running proxy endpoint comes from applied settings.

`sash status --watch` follows daemon events until interrupted, reconnects after management restarts or upgrades, and waits for a stopped instance without starting it. Interactive terminals redraw; redirected text appends snapshots. `--watch --json` emits one compact schema-2 status object per line, suppressing unchanged observations. The last observation determines the exit code on interruption; a closed output pipe exits `0` after cancelling the stream.

Ordinary status, including `--watch`, makes no outbound latency requests. Request a test explicitly:

```sh
sash status --delay DIRECT
sash status --delay "Proxy Group" --watch --json
```

The name must exactly match a node or group in the running configuration. A group tests its current outbound. The Core requests `https://www.gstatic.com/generate_204`, expects HTTP `204`, and uses a five-second timeout. Testing does not select a node, change routing mode or apply saved edits. A stopped/unavailable Core is reported without starting it.

With `--watch --delay`, the first test starts when Core is available; subsequent tests start 30 seconds after the previous result. Status events do not trigger extra tests. Tests never overlap, and Core replacement cancels/discards the old request before sampling the replacement.

Only an explicit delay request adds `delay: {name, url, timeoutMs, testedAt, state, delayMs, error}` to schema-2 JSON. States are `pending`, `ok`, `timeout`, `failed`, `not_found` and `unavailable`; unmeasured values are `null`. A failed or unavailable requested test sets `complete: false` and exit code `2`, while `healthy` still describes daemon/Core health. Invalid command arguments exit `1`.

Daemon, OS proxy and login startup probes run concurrently. Set `SASH_DEBUG=1` (or `true`) to include CLI error stacks on stderr; JSON command results stay on stdout. The generic `DEBUG` environment variable does not enable Sash diagnostics.

| Exit code | Meaning |
| --- | --- |
| `0` | Complete observation, including a known stopped state |
| `2` | Output produced, but some runtime/OS observation is unavailable |
| `1` | The command failed, for example due to corrupt local state |

- **Pending configuration:** click Apply or run `sash restart`. Saving alone does not change Core.
- **Core will not start on a config that uses GEO rules:** the Core downloads its geodata databases (`geoip.metadb`, `geosite.dat`, `country.mmdb`, `GeoLite2-ASN.mmdb`) while it loads a configuration, and it downloads them **itself, ignoring `HTTP_PROXY`**. On a network that cannot reach `github.com` directly this would deadlock — no proxy, because the Core has not started yet, and no Core, because it cannot download geodata. Sash therefore retries once through its release-mirror list and writes that `geox-url` into `runtime/config.yaml`, so the databases land in the data directory and later starts do not need the network again.

  If the retry also fails (`Core could not download its geodata databases`), Sash has no reachable source. Either provide one: set `geox-url` in the profile to a mirror you trust, or copy the databases into the data directory yourself (they are published as release assets of `MetaCubeX/meta-rules-dat`: `geoip.metadb`, `geosite.dat`, `country.mmdb`, `GeoLite2-ASN.mmdb`) and start Core again. A system-wide tunnel also works, because it routes the Core's own traffic; a proxy environment variable does not.
- **Apply failed:** inspect the displayed error and `sash logs --errors`; correct the saved profile and apply again.
- **Proxy restoration blocked:** keep the ownership journal and inspect the current Windows settings. Sash will not overwrite third-party changes or stop a healthy Core while restoration fails.
- **Daemon ownership unknown:** inspect its logs and PID/lease records; Sash will not kill an unverified process or start a competitor.
- **Interrupted update:** stop and start the daemon so its startup recovery can run. Corrupt or unrecognized backup/metadata files are preserved for inspection.
- **Interrupted Sash upgrade:** npm was replacing the package while the daemon was stopped. Start the installed version with `sash start`; if npm did not complete the installation, repair it with `npm install --global @astralyn/sash@<version>` before starting again.
- **Login startup failed:** read `sash auto status` and `sash logs --startup`; repair the entry with `sash auto on`.
- **Shutdown failed:** the management API remains available for retry. Resolve the reported proxy/Core failure and repeat `sash stop`.
- **Proxy changes are not visible in another application:** Sash tries PowerShell 7 and then the Windows PowerShell host to notify WinINet. If neither notification succeeds, registry changes and normal ownership verification still complete, with a warning in the command/daemon log. Restart affected applications or repair PowerShell availability to pick up the changes.
- **Dashboard assets missing:** reinstall the Sash package, or run `npm run build` in a source checkout. The dashboard route reports this explicitly.

Windows proxy/PAC restoration and login startup are the only desktop integrations. Basic Core/CLI operation remains portable. Sash has no TUN or service mode; generated configuration always disables TUN and rejects a separate TUN listener.
