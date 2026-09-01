# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Local profile library under `<root>/profiles/`: one timestamp-named YAML file per profile plus `index.json` metadata, active selection, provider update interval, quota/expiry data and persisted update errors.
- WebUI Profiles page with URL download, clipboard paste, local YAML import, Update All, profile cards, active selection, quota display and delete confirmation.
- Profile daemon API: list/add/import/activate/update/update-all/delete endpoints and scheduled due-profile refresh.
- Shared daemon/profile API contracts used by the server client and WebUI.
- State-changing daemon requests now accept the persistent CLI bearer or a per-boot WebUI token, with loopback Host validation.
- WebUI store and confirm-dialog regression tests are included in the normal test runner.

### Changed

- WebUI navigation is Overview, Profiles, Logs, Connections, Rules, Settings; the legacy `#/subscription` hash redirects to `#/profiles`.
- Profile behavior is owned by a single `ProfileService` used by daemon routes and offline CLI commands. Config activation/update transitions snapshot and restore prior state on failure.
- Remote profile refreshes use in-flight deduplication, bounded network concurrency and serialized state commits.
- The legacy `subscriptionUrl` setting migrates once into the profile index and is then removed instead of remaining as a second source of truth.
- The default mixed port is consistently `17890`. Installed core version is read from `state/install.json` instead of duplicated in settings.
- Core updates download and validate the staged binary before stopping the existing runtime, and commit install metadata only after health checks pass.
- Overview proxy groups share a reusable component; WebUI runtime refresh and polling are centralized in store actions.
- `npm test` now runs server TypeScript, `vue-tsc`, backend tests and WebUI tests. WebUI TypeScript is included in Biome checks.
- Vite uses its Node API and a Node-20-compatible release line; unused archive/version dependencies were removed. Published backend source maps are disabled.

### Fixed

- Release downloads now require the production host allowlist for both initial URLs and every redirect target.
- Failed core updates restore both the previous binary and install record; inactive updates still validate the staged executable before deleting `.bak`.
- Activating a missing/invalid local profile no longer silently keeps the previous config, and reload failures restore the previous active/config state.
- Changing `mixed-port` while system proxy is enabled now disables the old binding during restart and applies the new port afterward.
- Public daemon status/settings responses no longer expose controller or daemon secrets; unauthenticated mutation requests are rejected.
- Corrupt `sash.json` and `profiles/index.json` files are rejected without being overwritten by defaults.
- Profile home-page metadata accepts only HTTP(S), and invalid provider container shapes are rejected during config validation.
- PID records now use atomic writes. Static dashboard streams handle read failures and support `HEAD`.
- `GET /ui` redirects to `/ui/` while preserving the query string, so relative dashboard assets resolve correctly.
- WebUI polling no longer overlaps, Settings polling no longer overwrites a dirty port input, and logs continue auto-scrolling after the 600-row cap.
- Confirm dialogs no longer leave older Promises pending; Escape and route changes cancel the active dialog.
- Empty `204 No Content` responses are handled through typed void requests instead of JSON parsing/casts.
- A late exit event from a replaced core process no longer clears the new child handle or PID record.

## [0.1.0] - 2026-08-31

### Added

- Initial release: full lifecycle management for a rule-based network core (`start` / `stop` / `restart` / `status` / `logs`).
- First-run bootstrap that downloads the latest core and web dashboard, with automatic fallback to public GitHub mirrors.
- Remote profile management: `sash sub set|update|show|unset` with hot reload of the running core.
- Integrated web dashboard served by the core's external controller.
- `sash update`: atomic core upgrades with automatic rollback.
- `sash upgrade`: self-upgrade via npm.
- `sash config`: managed keys (`tun`, `allow-lan`, `mixed-port`, `controller`, `secret`) with config regeneration and reload.
- Cross-platform data directory conventions with `SASH_HOME` override.
- Background process supervision with PID identity verification and safe, conservative termination.
- Dashboard auto-authentication: `sash web` opens the dashboard through its own setup deep-link, passing the controller address and secret as query parameters, so the panel connects without a sign-in step. No credentials are written to disk.
- README now documents behavior that was previously only in code: Sash-owned operational keys override profile values (`mixed-port`/`controller`/`secret`/`tun`/`allow-lan` etc.), the `sash.json` settings file (defaults, auto-generated secret, `secret regenerate`), restart-on-config-change and profile refetch semantics, `web --no-open` printing a credential-bearing URL, the fail-closed `stop` refusal mode, best-effort dashboard installation, and the pre-x86-64-v3 CPU workaround.

### Fixed

- `sash config set` for listener/auth keys (`controller`, `secret`, `tun`, `mixed-port`, `allow-lan`) now restarts a running core instead of attempting a hot reload that could never reach it.
- Download redirect targets are now validated against the host allowlist hop-by-hop; partial downloads are cleaned up on failure.
- Archive extraction hardening: dashboard tarballs only accept regular files/directories (no symlink/hardlink/path-traversal entries); core `.gz` decompression is streamed with a size cap; multi-executable zips prefer the `mihomo*.exe` entry.
- Startup health polling no longer spawns a process-identity probe on every tick (Windows PowerShell stall).
- `stop` keeps the pid record when a process's identity cannot be verified, instead of orphaning it.
- Removed a dead API client method that would hang on the core's infinite traffic stream.
- `sash logs -n` rejects non-positive-integer input; `controller` validation accepts IPv6 and enforces port range.
- `ALL_PROXY` is honoured via dispatcher constructor options without mutating `process.env`.
