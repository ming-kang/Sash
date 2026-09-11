# Sash User & Operations Guide

Sash is a network toolbox for developers, learning and research. Use the CLI for commands and the built-in dashboard for profiles, settings and live traffic. Node.js 24 or newer is required; Windows is the primary desktop platform.

[Backend architecture](./backend.md) · [Frontend architecture](./frontend.md) · [Start at login](./autostart.md)

## Start and configure

```sh
sash web         # open and authorize the dashboard
sash start       # install Core if needed, then start with saved settings
sash status
sash stop        # restore the prior proxy and stop Sash and Core
```

`sash web` works while Core is stopped. In **Profiles**, import a YAML file or remote URL, then select it. Changes are saved first. Click **Apply configuration** or run `sash restart` to use them; restarting Core briefly interrupts connections. Overview shows the profile and proxy port currently in use.

Validation failure leaves the previous Core running. If the new configuration fails to start, saved edits remain and the dashboard stays available for correction.

## Commands

Run `sash <command> --help` for all options. Bare `sash` reads status once.

| Command | Action |
| --- | --- |
| `sash start` | Start Core with saved settings if it is stopped |
| `sash restart` | Apply saved settings and restart Core |
| `sash stop` | Restore the prior proxy and stop Sash and Core |
| `sash stop --core` | Stop Core and restore the proxy; keep the dashboard open |
| `sash web [--no-open]` | Open and authorize the dashboard; `--no-open` only prints its address |
| `sash status [--json] [--watch] [--delay NAME]` | Inspect Sash; optionally follow changes or test one outbound |
| `sash doctor [--json]` | Check installation, files, ports and Windows integration |
| `sash update [tag] [--check] [--json]` | Install or check a Core release |
| `sash upgrade [version] [--check] [--no-restart] [--json]` | Update the Sash package through npm |
| `sash proxy [on\|off\|status] [--json]` | Set or inspect the Windows system proxy |
| `sash mode rule\|global\|direct [--json]` | Change the running Core's routing mode |
| `sash auto [on\|off\|status] [--json]` | Set or inspect Windows start at login |
| `sash logs [-n N] [-f] [--errors] [--daemon]` | Read Core logs, or Sash logs with `--daemon` |
| `sash logs --startup [-n N] [-f]` | Read login-startup attempts |
| `sash version` | Print the installed Sash version |

### Profile commands

All profile commands support `--json`. A profile argument is its full ID or a unique exact name; use the ID if names collide.

| Command | Action |
| --- | --- |
| `sash profile [list]` | List saved profiles and selection |
| `sash profile use <profile>` / `use --default` | Select a profile or the built-in DIRECT-only configuration |
| `sash profile add <url> [--name NAME] [--use]` | Download a profile; the first is selected automatically |
| `sash profile update [profile] [--all]` | Update one remote profile, the selected one, or all |
| `sash profile rename <profile> <name>` | Rename a profile |
| `sash profile remove <profile>` | Remove a profile |

These commands save changes for the next Apply. Listing profiles also works while Sash is stopped. A partly failed `update --all` returns per-profile errors and exit code `1`.

## Settings and profiles

```sh
sash profile add https://example.com/profile.yaml --name Work --use
sash profile update Work
sash restart               # apply saved profiles and network settings
sash mode global           # change the running mode
sash proxy on              # requires a healthy Core
```

The Settings page saves the proxy port and LAN access for the next Apply. Mode and node selection affect the running Core; a later Apply uses the saved profile again. The system-proxy switch acts immediately. If turning it off fails, the off preference stays saved; resolve the Windows error and retry.

Profiles must be YAML objects in Core format. The editor can open damaged YAML for repair and checks it on save. If another tab has edited the same content, reopen the current version before saving again.

Remote profiles use the provider's update interval, defaulting to 24 hours. Sash checks for due updates every 15 minutes and backs off after failures. Downloads save content for the next Apply; unchanged content keeps its revision. Empty quota/expiry fields display as unknown, while zero remains zero.

See [Automatic Startup](./autostart.md) to start the saved configuration at login.

## Browser access

Run `sash web` with the same user and `SASH_HOME` as the instance. It authorizes a tab using a private, single-use handoff that expires after 90 seconds. Rerun the command if it expires.

Authorization survives page refreshes and Sash/Core restarts. Sessions expire after twelve idle hours and renew while used. If browser storage is disabled, authorization lasts only for the current page. Opening a bare dashboard address shows connection instructions.

## PowerShell completion

Load the bundled script in PowerShell 7:

```powershell
. (Join-Path (npm root --global) '@astralyn/sash/docs/completions/sash.ps1')
```

Add that line to `$PROFILE` for future sessions. From a source checkout, use `. ./docs/completions/sash.ps1`. Completion covers commands, options and fixed choices without running Sash; enter profile names, URLs and versions yourself.

## State format and data

`sash.json` contains `{schemaVersion: 2, revision, settings, profiles}`. These keys live inside `settings`:

| Key | Default | Meaning |
| --- | --- | --- |
| `mixedPort` | `7890` | HTTP/SOCKS proxy port |
| `allowLan` | `false` | Accept proxy traffic from other devices |
| `systemProxy` | `false` | Saved Windows system-proxy preference |
| `controller` | `127.0.0.1:9090` | Internal Core controller |
| `daemonPort` | `19090` | Local API and dashboard port |
| `secret` | random | Core controller credential |
| `daemonSecret` | random | CLI credential |

Edit controller/local API addresses or credentials only while Sash is stopped, then start it again. All three ports must differ, the controller must use loopback and secrets must be nonblank.

| Platform | Default data folder |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Sash` |
| macOS | `~/Library/Application Support/Sash` |
| Linux | `$XDG_DATA_HOME/sash` or `~/.local/share/sash` |

An absolute `SASH_HOME` selects another folder. Use a local filesystem that supports atomic rename and hard links.

| Path in the data folder | Contents |
| --- | --- |
| `sash.json`, `sash.json.bak` | Settings, saved profile selection and a recovery copy |
| `profiles/<id>/<revision>.yaml` | Profile source text |
| `runtime/config.yaml` | Generated core config |
| `bin/` | Core executable and update backup |
| `state/` | Process records, Core installation, proxy recovery and browser session hashes |
| `logs/` | Core, Sash and login-startup logs |
| `ui/` | Optional custom dashboard |

Use the profile editor for source changes; Sash generates `runtime/config.yaml` on Apply. Maintenance cleans recognized orphan files after 24 hours. POSIX private state and logs use `0600`.

## Updates

### Core

```sh
sash update --check         # inspect release metadata
sash update                # install the latest Core release
sash update v1.19.30        # install an exact release tag
```

Sash selects an official build that runs on the processor, verifies its download and keeps the previous binary until the new Core passes a health check. Failure restores the executable and install record.

The dashboard stays available. Updates preserve whether Core was running; an update while stopped starts Core briefly for verification, then stops it. `--check` reads installation and release metadata without starting Sash or Core. `--json` prints one result instead of progress text.

### Sash package

```sh
sash upgrade --check        # check the npm release and Node requirement
sash upgrade               # install, then restart Sash
sash start                 # resume Core after the Sash restart
sash upgrade --no-restart   # install now; restart Sash yourself later
```

The default target is npm's `latest` release. Pass an exact published version to upgrade or downgrade. Automatic upgrades require a direct global npm installation; source checkouts, linked packages and other package managers report why they are unsupported.

npm installs **while Sash keeps running**, then Sash restarts to load the new package. A failed install leaves the running instance available. `--no-restart` keeps the current process running. Other instances sharing the package load it on their next start.

For a manual upgrade, run `npm install -g @astralyn/sash` while Sash is running, then `sash stop && sash start`. `--check` changes nothing and never starts Sash.

| JSON output | Contents |
| --- | --- |
| `sash upgrade --check --json` | `current`, `target`, `available`, `compatible`, `supported`, `installation`, `prefix`, `node`, `requiredNode`, `reason` |
| Successful install | `{outcome: "upgraded", version, restarted}` |
| Nothing installed | Inspection report, `version` and `outcome`: `current`, `unsupported` or `incompatible` |
| Failure | `{outcome: "failed", error}` |

With `--json`, npm output goes to stderr. A check, already-current version or successful install exits `0`; an unsupported/incompatible execution or failure exits `1`.

## Status and troubleshooting

Start with `sash doctor` for installation problems. It reads saved state, files and runtime observations independently, and checks whether stopped listener ports are available.

`sash status --watch` follows changes and reconnects after Sash restarts. It waits for a stopped instance without starting it. `--watch --json` emits one status object per line when observations change.

Latency testing is explicit:

```sh
sash status --delay DIRECT
sash status --delay "Proxy Group" --watch --json
```

Use an exact node or group name. Core requests `https://www.gstatic.com/generate_204` with a five-second timeout; a group tests its selected outbound. Watch mode repeats 30 seconds after each result. Tests keep the current node, mode and saved configuration unchanged.

| JSON command | Format |
| --- | --- |
| `status --json` | `schemaVersion: 2`; runtime, endpoints, profile, proxy, startup, `complete` and `healthy`; unknown observations are `null` |
| `status --delay NAME --json` | Also includes `delay: {name, url, timeoutMs, testedAt, state, delayMs, error}` |
| `doctor --json` | `schemaVersion: 1`; `healthy`, `complete` and named `checks` with status and advice |

Delay states are `pending`, `ok`, `timeout`, `failed`, `not_found` and `unavailable`. A failed or unavailable requested test sets `complete: false` and exit code `2`; `healthy` still describes Sash/Core health. Doctor check statuses are `ok`, `info`, `warning` and `error`.

| Exit code | Meaning |
| --- | --- |
| `0` | Success or complete observation, including a known stopped state |
| `1` | Command failure or a definite diagnostic fault |
| `2` | Incomplete observation without a definite diagnostic fault |

| Problem | Next step |
| --- | --- |
| Pending configuration | Click Apply or run `sash restart` |
| Apply/start failed | Read `sash logs --errors`, correct the profile and retry |
| Geodata download failed | Set a trusted `geox-url` in the profile or place the required databases in the data folder; see below |
| Proxy restoration blocked | Inspect Windows proxy/PAC settings and keep `state/system-proxy.json` for recovery |
| Sash cannot confirm a process | Inspect `sash logs --daemon --errors` and run `sash doctor` |
| Interrupted Core update | Restart Sash to run recovery; preserve backup files if recovery reports an error |
| Interrupted Sash upgrade | Finish `npm install -g @astralyn/sash@<version>` while the running instance stays available, then restart it |
| Login startup failed | Read `sash auto status` and `sash logs --startup`; repair with `sash auto on` |
| Shutdown failed | Resolve the reported proxy/Core problem and retry `sash stop` |
| Proxy change absent in an app | Restart the affected app; if logs report notification failure, repair PowerShell availability |
| Dashboard assets missing | Reinstall the package, or run `npm run build` in a source checkout |

Core fetches geodata itself, ignoring `HTTP_PROXY`. Sash retries a failed fetch once through mirrors. If that also fails, provide a reachable `geox-url` or pre-seed the databases named by the error: `geoip.metadb`, `geosite.dat`, `country.mmdb` or `GeoLite2-ASN.mmdb`. A system-wide tunnel can also supply connectivity.

Sash manages Windows desktop proxy/PAC settings. Doctor may report separate VPN/dial-up proxy records; inspect those in Windows even if the connection is inactive. Core/CLI operation is portable to macOS and Linux; desktop proxy and startup integration are Windows-only. The generated core config disables TUN.

Logs can be followed with `-f`, including across file creation and rotation. `--startup` cannot be combined with `--daemon` or `--errors`. Set `SASH_DEBUG=1` or `true` to include CLI error stacks on stderr.
