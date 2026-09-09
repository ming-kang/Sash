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
| `sash start` | Ensure management exists; start with saved configuration if stopped. Repeated starts check the running Core and proxy intent. |
| `sash restart` | Apply saved configuration and restart Core; keep the daemon and browser sessions. |
| `sash stop` | Restore proxy, stop Core and exit management. Report an error if safe shutdown cannot be verified. |
| `sash stop --core` | Restore proxy and stop Core while retaining management and browser access. |
| `sash status [--json]` | Read runtime, endpoint, saved profile, proxy and autostart observations. Bare `sash` does the same. |
| `sash web` | Start management if needed and authorize/open the dashboard. |
| `sash web --no-open` | Start management and print its address without authorizing a browser. |
| `sash update [--version TAG]` | Download, verify and install a Core release through the daemon. |
| `sash upgrade [version] [--check] [--json]` | Update the Sash package and dashboard, then restore all instances sharing its installation. |
| `sash profile [list]` | List saved profiles; `list --json` returns their metadata and saved selection. |
| `sash profile use <profile>` / `use --default` | Select an ID or unique exact name, or the built-in configuration, for the next Apply. |
| `sash profile add <url> [--name NAME] [--use]` | Download and save a remote profile; the first profile is selected automatically. |
| `sash profile update [profile] [--all]` | Update the specified or selected remote profile, or all remote profiles. |
| `sash profile rename <profile> <name>` / `remove <profile>` | Rename or remove the saved profile identified by ID or exact name. |
| `sash proxy [on\|off\|status] [--json]` | Set system-proxy intent or inspect desired, Sash-applied and OS-observed state. |
| `sash mode rule\|global\|direct [--json]` | Change the running Core's mode; the next Apply restores the saved profile's mode. |
| `sash auto [on\|off\|status]` | Set or inspect Windows login startup. No argument means status. |
| `sash logs [-n N] [-f] [--errors] [--daemon]` | Read Core or daemon logs; follow waits for creation and handles rotation. |
| `sash logs --startup [-n N] [-f]` | Read login attempts, including settings errors before daemon startup. |
| `sash version` | Print the package version. |

`sash stop --core` and WebUI **Stop Core** keep the management process open. `sash upgrade` replaces Sash program code and restarts affected management processes automatically. `restart` applies saved configuration to Core.

## Browser access

Run `sash web` as the same user and with the same `SASH_HOME` as the instance. A private local handoff authorizes the browser without printing credentials. It expires after 90 seconds and works once; rerun the command if needed.

An authorized tab survives refresh and Core restarts/updates. Sessions expire after twelve idle hours and renew while used. A normal daemon restart needs a new authorization; `sash upgrade` provides a ten-minute continuation for already authorized tabs. If browser storage is disabled, authorization lasts only for the current page. Opening a bare dashboard address displays connection instructions.

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
state/install.json              installed version
state/core-update-transaction.json  active binary update/recovery
state/sash-upgrade-handoff.json  private runtime snapshot during Sash replacement
state/system-proxy.json         original proxy snapshot and recovery phase
state/sash.pid, state/sashd.pid  process discovery records
state/sashd*.lock               daemon singleton/startup ownership
logs/                           Core, daemon and login diagnostics
ui/                             optional custom dashboard override
```

The manifest and sources use atomic publication. Old source revisions may be cleaned after successful saves; this is not a version-history feature. Do not edit generated runtime configuration. POSIX private state/logs use `0600`.

## Updates

Core updates keep the dashboard available and preserve whether Core was running. Even an initially stopped update performs a temporary startup/health check, then stops again. `.bak` is retained until the new binary passes verification and the original running state is restored. Failure rolls back the executable and install record; saved profiles/settings are not part of this transaction.

Downloads require official SHA-256 metadata, trusted HTTPS origins and bounded extraction. If verification cannot complete, the update fails rather than executing unverifiable bytes.

Update Sash itself:

```sh
sash upgrade --check       # inspect the latest release and compatibility
sash upgrade               # update Sash and restore affected instances
sash upgrade --json        # machine-readable result; progress is suppressed
```

The default target is the official npm `latest` release. An optional exact published version selects an upgrade or downgrade. An already-current version exits successfully. `--check` leaves the installation and data directories unchanged and never starts management. Source checkouts, linked packages and other package managers receive guidance for their installation method.

Sash checks Node compatibility and prepares the package, dependencies and recovery files before stopping anything. It coordinates all data directories sharing the installation, restarts their original management/Core state, preserves the actual applied configuration, and keeps saved but unapplied edits pending. Core's version remains unchanged. Working login startup and Sash-owned proxy settings are restored with the runtime; the dashboard reconnects through its private session continuation. Connections are briefly interrupted while running Core instances restart.

Installation or health failures restore the previous package and runtime without a network download. After an interrupted upgrade, run `sash upgrade` again to finish recovery. The command remains available through a recovery launcher even if the package directory was temporarily moved. Keep the reported recovery files when ownership cannot be verified, resolve the reported conflict and retry. A recovered transaction exits before starting a new version change.

`--check --json` reports `current`, `target`, `available`, `compatible`, `supported` and any pending recovery. Execution JSON also reports an `outcome`; completed transactions include the installed `version`, restored instance count and `recoveryRequired`. Exit code `0` means a successful check, no-op, upgrade or recovery; `1` means an unsupported/incompatible execution or failure. Check `compatible` and `supported` when consuming a successful check.

For manual package-manager maintenance, stop affected instances first, update using their installation method, then start them again. `sash update --force` is unavailable. Damaged Core installations are diagnosed and preserved; stop the existing instance before using a clean data directory for reinstallation.

## Status and troubleshooting

`sash status --json` uses `schemaVersion: 2`. It includes `complete`, `healthy`, `queryError`, daemon/Core state, desired/applied/observed proxy state, autostart, endpoints, saved active profile and paths. Unknown observations remain `null`; no TUN fields are emitted. The running proxy endpoint comes from applied settings.

| Exit code | Meaning |
| --- | --- |
| `0` | Complete observation, including a known stopped state |
| `2` | Output produced, but some runtime/OS observation is unavailable |
| `1` | The command failed, for example due to corrupt local state |

- **Pending configuration:** click Apply or run `sash restart`. Saving alone does not change Core.
- **Apply failed:** inspect the displayed error and `sash logs --errors`; correct the saved profile and apply again.
- **Proxy restoration blocked:** keep the ownership journal and inspect the current Windows settings. Sash will not overwrite third-party changes or stop a healthy Core while restoration fails.
- **Daemon ownership unknown:** inspect its logs and PID/lease records; Sash will not kill an unverified process or start a competitor.
- **Interrupted update:** stop and start the daemon so its startup recovery can run. Corrupt or unrecognized backup/metadata files are preserved for inspection.
- **Interrupted Sash upgrade:** run `sash upgrade`; `sash upgrade --check` reports the pending phase without changing it.
- **Login startup failed:** read `sash auto status` and `sash logs --startup`; repair the entry with `sash auto on`.
- **Shutdown failed:** the management API remains available for retry. Resolve the reported proxy/Core failure and repeat `sash stop`.

Windows proxy/PAC restoration and login startup are the only desktop integrations. Basic Core/CLI operation remains portable. Sash has no TUN or service mode; generated configuration always disables TUN and rejects a separate TUN listener.
