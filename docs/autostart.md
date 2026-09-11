# Automatic Startup

Start Sash in the background when the current Windows user signs in. Use **Settings → Start at Login** or the CLI:

```sh
sash auto on       # enable or repair
sash auto off      # remove
sash auto status   # inspect; bare "sash auto" does the same
```

This affects future logins. Use `sash start` and `sash stop` for the current session.

[Usage](./usage.md) · [Backend architecture](./backend.md)

## Installation and data folder

Enabling requires a direct global npm installation:

```sh
npm install -g @astralyn/sash
sash auto on
```

Source checkouts, `npm link`, local dependencies and temporary `npx` installations can inspect or remove an entry, but cannot enable it.

The launcher records the absolute Node executable, Sash entry point and data folder, including an absolute `SASH_HOME`. There is one entry per Windows user; enabling it with another data folder replaces the target.

After moving Node or changing the npm prefix, run `sash auto on` to repair the entry. Upgrading Sash in the same prefix preserves it.

## Login behavior

Windows registers a `Sash` value in the current user's `Run` key. Its hidden WScript launcher runs the normal `sash start` flow, using saved settings, the selected profile and the system-proxy preference. It opens neither a console nor a browser.

Sash performs registration changes. If stopped, `sash auto on/off` starts Sash's local API without starting Core. Other operating systems report startup integration as unsupported.

## Status and diagnostics

`sash auto status --json` returns `state`, `canEnable` and `reason`. `sash status --json` includes the same fields under `autostart`:

| JSON state | Meaning |
| --- | --- |
| `on` | Current launcher is registered and enabled in Windows |
| `off` | No entry is registered |
| `stale` | Launcher, installation or data folder differs |
| `disabled` | Windows has disabled the current entry |
| `unknown` | Inspection failed; `reason` explains why |
| `unsupported` | Platform has no supported startup integration |

`canEnable` says whether this installation can register a launcher. Failed observation returns exit code `2`; `sash auto off` remains available to remove an entry.

Each login attempt records its outcome in `<SASH_HOME>/logs/sash.log`, rotating at 1 MiB with one previous file:

```sh
sash logs --startup
sash logs --startup -f
```

These logs remain readable if invalid settings prevented startup. If no attempt appears, check the Windows startup entry and the recorded installation paths.

## Uninstalling

```sh
sash auto off
sash stop
npm uninstall -g @astralyn/sash
```

If the package is already gone, remove the `Sash` value from `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` and, if present, `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`. Then remove `%LOCALAPPDATA%\Sash\autostart\start.vbs`.
