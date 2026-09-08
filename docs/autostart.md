# Automatic Startup

Sash can start in the background when the current user signs in. Enable it from
**Settings → Start at Login** in the dashboard or from the CLI:

```sh
sash auto on       # enable or repair the startup entry
sash auto off      # remove the startup entry
sash auto status   # inspect without changing anything
sash auto          # turn an effective entry off; otherwise enable or repair it
```

Changing automatic startup affects future logins. Use `sash start` and `sash stop`
to control the current runtime. Automatic startup does not open a browser.

## Installation and Data Directory

Enabling requires a built, direct npm-global installation:

```sh
npm install -g @astralyn/sash
sash auto on
```

Source checkouts, `npm link`, local dependencies and temporary `npx` installations
cannot enable startup. They can still inspect or remove an existing entry.
The generated launcher records the absolute Node executable, Sash entry point and
current data directory. An absolute `SASH_HOME` override is preserved; it does not
depend on the login shell loading the same environment.

There is one startup entry per operating-system user. Enabling it with another
`SASH_HOME` replaces the entry to start that instance. Other instances report that
entry as `stale` because its target differs. Changing the Node installation or npm
prefix can also make the entry stale; run `sash auto on` from the new installation
to repair it. Upgrading Sash in the same prefix preserves the entry.

Automatic startup uses the normal `sash start` ownership and health-check flow.
It reads the saved settings and active profile at login, including the saved
system-proxy preference. Startup registration is managed by the OS, not by a
boolean in `sash.json`.

## Platform Behavior

| Platform | Registration | When it runs |
| :--- | :--- | :--- |
| Windows | `Sash` value in the current user's `Run` registry key; hidden WScript launcher | User sign-in, without a console window |
| macOS | `~/Library/LaunchAgents/com.astralyn.sash.plist` | Graphical user login |
| Linux | `$XDG_CONFIG_HOME/systemd/user/sash.service`, defaulting to `~/.config/systemd/user/sash.service` | Start of the systemd user session |

Linux requires systemd user services. To start them before a login on a headless
machine, enable lingering for the current user:

```sh
loginctl enable-linger
```

Sash does not install a privileged system service. Registering or removing startup
does not change system-proxy settings, reload the Core, or stop a running process.

## Status and Diagnostics

`sash status` includes automatic startup. `sash status --json` returns an
`autostart` object with `state`, `canEnable` and `reason`:

| State | Meaning |
| :--- | :--- |
| `on` | The current launcher is registered and enabled by the OS |
| `off` | No startup entry is registered |
| `stale` | An entry exists, but its launcher, installation paths or data directory differ |
| `disabled` | The current entry is disabled by the OS |
| `unknown` | The OS state could not be inspected |
| `unsupported` | This operating system has no supported startup backend |

`canEnable` reports whether this installation can register a stable launcher.
`reason` explains an unavailable installation or a failed inspection. An inspection
failure does not erase runtime observations; status still reports them and exits
with code `2`. Explicit `sash auto off` does not need a successful inspection.
The dashboard also provides **Refresh status** and **Remove startup entry** for
recovery.

Each login attempt records its start and outcome in `<SASH_HOME>/logs/sash.log`.
The log rotates at 1 MiB, retaining one previous file as `sash.log.1`:

```sh
sash logs --startup
sash logs --startup -f
```

These diagnostics remain readable when invalid settings prevented startup.
`--startup` cannot be combined with `--daemon` or `--errors`. If no attempt was
recorded, check the OS startup entry and the paths above first.

## Uninstalling

Remove startup before uninstalling the package:

```sh
sash auto off
sash stop
npm uninstall -g @astralyn/sash
```

If Sash has already been uninstalled, remove its startup entry manually:

- Windows: remove the `Sash` value under
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` and, if present,
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`.
  Then remove `%LOCALAPPDATA%\Sash\autostart\start.vbs`.
- macOS: remove `~/Library/LaunchAgents/com.astralyn.sash.plist`.
- Linux: run `systemctl --user disable sash.service`, then remove
  `$XDG_CONFIG_HOME/systemd/user/sash.service` (default `~/.config/systemd/user/sash.service`).
