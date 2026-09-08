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
| `sash status [--json]` | Read runtime, endpoint, saved profile, proxy and autostart observations. Bare `sash` does the same. |
| `sash web` | Start management if needed and authorize/open the dashboard. |
| `sash web --no-open` | Start management and print its address without authorizing a browser. |
| `sash update [--version TAG]` | Download, verify and install a Core release through the daemon. |
| `sash auto [on\|off\|status]` | Set or inspect Windows login startup. No argument means status. |
| `sash logs [-n N] [-f] [--errors] [--daemon]` | Read Core or daemon logs; follow waits for creation and handles rotation. |
| `sash logs --startup [-n N] [-f]` | Read login attempts, including settings errors before daemon startup. |
| `sash version` | Print the package version. |

WebUI **Stop Core** keeps the management process open. To reload updated Sash program code, use stop followed by start/web. `restart` only replaces Core.

## Browser access

Run `sash web` as the same user and with the same `SASH_HOME` as the instance. A private local handoff authorizes the browser without printing credentials. It expires after 90 seconds and works once; rerun the command if needed.

An authorized tab survives refresh and Core restarts/updates. A daemon restart needs a new authorization. If browser storage is disabled, authorization lasts only for the current page. Opening a bare dashboard address displays connection instructions.

## Settings and profiles

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

Update Sash itself through npm:

```sh
sash stop
npm install -g @astralyn/sash
sash start
sash web
```

`sash upgrade` and `sash update --force` are removed. Damaged installations are diagnosed and preserved; use a clean data directory for reinstalling after stopping the existing instance.

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
- **Login startup failed:** read `sash auto status` and `sash logs --startup`; repair the entry with `sash auto on`.
- **Shutdown failed:** the management API remains available for retry. Resolve the reported proxy/Core failure and repeat `sash stop`.

Windows proxy/PAC restoration and login startup are the only desktop integrations. Basic Core/CLI operation remains portable. TUN and service mode are outside this branch; generated configuration always disables TUN and rejects a separate TUN listener.
