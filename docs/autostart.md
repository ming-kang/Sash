# Automatic Startup

Start Sash in the background when the current Windows user signs in: **Overview → General → Auto Start**, or `sash auto on` (`off`, `status`; bare `sash auto` reads status). This affects future logins — use `sash start`/`sash stop` for the current session.

[Usage](./usage.md) · [Backend architecture](./backend.md)

## Requirements and registration

Enabling requires a direct global npm installation — source checkouts, `npm link` and temporary `npx` installs can inspect or remove an entry but cannot enable one.

The `Sash` value in the current user's `Run` key records the absolute Node executable, entry point and data folder (an absolute `SASH_HOME`); there is one entry per user, so enabling with a different data folder retargets it. After moving Node or changing the npm prefix, run `sash auto on` to repair; upgrading Sash in the same prefix preserves the entry.

## Login behavior

A hidden launcher runs the normal `sash start` flow — no console, no browser — and always starts Core, even if Sash was stopped at shutdown: the entry means "Sash is ready after sign-in". A network that is not ready yet is retried with backoff before the attempt is declared failed.

When Sash is stopped, `sash auto on`/`off` starts its local API briefly (not Core) to perform the registration change. Other operating systems report startup integration as unsupported.

## Diagnostics

`sash auto status --json` returns `state`, `canEnable` and `reason` (also under `autostart` in `sash status --json`); failed observation exits `2`.

The last login attempt is recorded in `state/login-start.json` and appended to `logs/sash.log`; `sash logs --startup [-f]` reads them even when invalid settings prevented startup. `sash status` surfaces a failed attempt in place and `sash doctor` reports it as the `login-start` check. If no attempt was recorded, check the registry entry and the recorded installation paths.

## Uninstalling

```sh
sash auto off
sash stop
npm uninstall -g @astralyn/sash
```

If the package is already gone, remove the `Sash` value from `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (and `Explorer\StartupApproved\Run` if present), then delete `%LOCALAPPDATA%\Sash\autostart\start.vbs`.
