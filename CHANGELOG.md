# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Built-in Vue 3 dashboard is bundled in the npm package under `dist/ui/`, with no runtime dashboard download.
- WebUI includes Chinese and English localization with a Settings-page language switcher.
- Dedicated `sash proxy on|off|status` commands manage explicit OS system-proxy ownership and recovery.
- Immutable `SettingsService` coordinates shared daemon/offline settings candidates, config validation and durable settings/config publication.
- Local profile library under `<root>/profiles/`: one timestamp-named YAML file per profile plus `index.json` metadata, active selection, provider update interval, quota/expiry data and persisted update errors.
- WebUI Profiles page with URL download, clipboard paste, local YAML import, Update All, profile cards, active selection, quota display and delete confirmation.
- Profile daemon API: list/add/import/activate/update/update-all/delete endpoints and scheduled due-profile refresh.
- Shared daemon/profile API contracts used by the server client and WebUI.
- State-changing daemon requests now accept the persistent CLI bearer or a per-boot WebUI token, with loopback Host validation.
- WebUI store and confirm-dialog regression tests are included in the normal test runner.
- Exact generated configurations are validated by the installed Core in an isolated temporary file before profile/config state is committed.
- One-time, crash-recoverable import of a qualifying pre-profile `config.yaml` into an active local profile, with conservative default-config detection and fail-closed validation.
- Versioned `sash.json` runtime schema with strict field validation and explicit v0 migration.
- Atomic daemon/start/runtime/mutation/settings leases for single-instance and cross-process state ownership.
- Durable first-install Core publication journal with publishing/committed crash recovery.
- Authenticated maintenance shutdown API returning an atomic Core-running snapshot for executable updates.
- Durable system-proxy ownership journal that snapshots and conditionally restores prior manual/PAC state.
- Windows/macOS/Linux and Node.js 24 CI matrix covering lint, tests, builds and package dry-runs.

### Changed

- WebUI functional iconography now uses tree-shaken Remix Icon line components behind the existing semantic icon API.
- Built-in WebUI now uses a responsive, theme-aware data-console layout with desktop and mobile navigation, compact runtime cards, accessible controls, paginated data views and reduced background polling.
- Repeated `sash start` requests now always enter the daemon lifecycle reconciler, so desired runtime and system-proxy state are refreshed even when a Core is already running.
- Shutdown acknowledges success only after Core/proxy cleanup; listener closure follows the response, while failed cleanup keeps the daemon scheduler available for retry.
- Log tailing and follow-mode growth reads use bounded 64 KiB chunks instead of whole-file or whole-delta allocations.
- The internal Core controller address is restricted to loopback hosts so its bearer is never sent to a remote endpoint.
- HTTP requests use absolute deadlines, bounded body ownership and method-aware retry defaults; state-changing requests are not retried unless explicitly requested.
- Remote profile redirects are validated hop-by-hop, reject HTTPS downgrade and cannot cross from public origins into literal private/loopback targets.
- WebUI navigation is Overview, Profiles, Logs, Connections, Rules, Settings; the legacy `#/subscription` hash redirects to `#/profiles`.
- Profile behavior is owned by a single `ProfileService` used by daemon routes and offline CLI commands. Config activation/update transitions snapshot and restore prior state on failure.
- Remote profile refreshes use in-flight deduplication, bounded network concurrency and serialized state commits.
- The legacy `subscriptionUrl` setting migrates once into the profile index and is then removed instead of remaining as a second source of truth; it takes priority over unmanaged-config import.
- Runtime config generation now has only two canonical inputs: the active profile or the built-in DIRECT-only default. The dead existing-`config.yaml` fallback pipeline was removed.
- Every Core start recompiles and validates `config.yaml` from the active profile and current settings. Remote profile responses are limited to 8 MiB.
- The default mixed port is consistently `17890`. Installed core version is read from `state/install.json` instead of duplicated in settings.
- Core updates download and validate the staged binary before stopping the existing runtime, and commit install metadata only after health checks pass.
- Overview proxy groups share a reusable component; WebUI runtime refresh, profile mutations, mode/proxy intent and polling are centralized in store actions with per-domain generations.
- Daemon status exposes a per-boot monotonic profile revision so scheduled profile publications trigger one coherent WebUI runtime refresh without adding heavy requests to every poll.
- `npm test` now runs server TypeScript, `vue-tsc`, backend tests and WebUI tests. WebUI TypeScript is included in Biome checks.
- The minimum runtime is Node.js 24 across package metadata, the early CLI guard, documentation and CI. Vite continues to use its Node API; unused archive/version dependencies were removed, and published backend source maps are disabled.
- Core/proxy transitions now pass through one serialized runtime lifecycle; proxy restoration precedes deliberate Core shutdown and readiness precedes proxy apply.
- Offline mutations reload committed settings under lock and refuse uncertain daemon/orphan-Core ownership.
- Core release mirrors are transport-only: official GitHub metadata selects the release and supplies the mandatory SHA-256 digest.
- Core updates stage outside runtime ownership, use the daemon's atomic maintenance snapshot instead of a stale status read, then serialize offline publication/restoration against start/stop.
- Core ZIP extraction accepts only the expected upstream executable basename; npm self-upgrade versions are restricted to strict semver or safe dist-tags.
- Core updates temporarily stop the daemon, validate the staged binary/config and recover interrupted `.bak` states before publication.
- System-proxy backends preserve manual, automatic/PAC and authentication-mode fields they modify; Linux automation is explicitly GNOME `gsettings` only.
- npm packages now include `docs/`, lint is part of `prepublishOnly`, and package self-upgrade requires the daemon to be stopped so runtime/schema versions cannot overlap.

### Fixed

- Malformed HTTP and WebSocket request targets are rejected inside explicit daemon error boundaries instead of terminating sashd through an unhandled rejection.
- TUN state now reflects the Core's actual runtime `tun.enable`: online activation that remains inactive or unverified rolls settings/config/runtime back, while CLI and WebUI distinguish desired, active, inactive and unverified states and explain how to restart the whole Sash daemon with elevated privileges on each platform.
- WebUI normalizes an empty Core connection snapshot so Overview renders correctly with zero active connections.
- Controller status and system-proxy transitions now detect Core exit/replacement across asynchronous probes and release a just-applied proxy binding when ownership is lost.
- CLI stop now fails when daemon shutdown cannot be safely verified, and daemon-client shutdown errors are no longer discarded.
- Settings updates use immutable candidates and one shared online/offline service; validation rejects blank/control-character secrets and listener-port collisions, while failed runtime transitions restore prior settings/config/runtime state.
- Settings, Profile YAML, index and generated config publish through one fixed-role durable transaction; failed activations, missing-profile fetches, updates and deletes compensate immediately, while interrupted publication recovers on daemon or offline initialization.
- Profile request parsing, fetch, rendering and Core validation now run outside the short mutation lock; daemon and offline commits recheck profile identity/selection under the lock before publication.
- Profile index loading now rejects duplicate IDs, non-plain roots and unexpected root fields.
- Invalid unmanaged `config.yaml` migration candidates are left untouched and block migration instead of being silently replaced.
- System-proxy backends are split into focused platform modules; macOS empty fields and malformed Windows registry output now fail safely.
- System-proxy recovery persists a `restoring` phase so partial multi-field restoration can continue after a crash.
- Atomic state writes fsync the parent directory on POSIX after publication.
- Process termination now revalidates ownership before both graceful and force signals, and daemon shutdown verifies the current boot token in every ownership mode.
- WebUI traffic/log WebSockets now complete browser subprotocol negotiation while keeping private authentication protocols away from the Core.
- Release downloads now require the production host allowlist for both initial URLs and every redirect target.
- Failed core updates restore both the previous binary and install record; inactive updates still validate the staged executable before deleting `.bak`.
- Activating a missing/invalid local profile no longer silently keeps the previous config, and reload failures restore the previous active/config state.
- Changing `mixed-port` while system proxy is enabled now disables the old binding during restart and applies the new port afterward.
- Public daemon status/settings responses no longer expose controller or daemon secrets; unauthenticated mutation requests are rejected.
- Daemon bearer/boot-token headers are stripped before requests enter the core controller reverse proxy.
- WebSocket Core streams now require loopback Host/Origin validation and bearer/boot-token authentication; the private WebUI token subprotocol is removed upstream.
- Reverse-proxy path matching now rejects lookalike prefixes such as `/core/apiX`.
- Failed settings validation/Core restart restores previous settings, generated config and runtime where possible.
- Offline `sash proxy off` now persists the desired proxy state as disabled before OS cleanup.
- Corrupt `sash.json` and `profiles/index.json` files are rejected without being overwritten by defaults.
- Profile home-page metadata accepts only HTTP(S), and invalid provider container shapes are rejected during config validation.
- PID records now use atomic writes. Static dashboard streams handle read failures and support `HEAD`.
- `GET /ui` redirects to `/ui/` while preserving the query string, so relative dashboard assets resolve correctly.
- WebUI polling no longer overlaps, Settings polling no longer overwrites a dirty port input, and logs continue auto-scrolling after the 600-row cap.
- WebUI Core-owned snapshots and traffic are cleared when runtime ownership is lost; stopped polling skips Core endpoints and recovery/profile revisions refresh configs, proxies, rules, connections and profiles once.
- System proxy disable remains available for desired/applied/OS-observed recovery while Core is stopped, while enable requires a healthy Core and actions follow the switch target state.
- Stale runtime/profile/mode/proxy responses can no longer overwrite newer intent; same-domain controls are disabled during mutations, failed single-profile updates refresh persisted errors, and committed TUN/LAN toggles update immediately.
- Manual latency results survive ordinary proxy polling and are cleared only when Core/profile ownership changes; traffic WebSockets stop with unavailable sessions/runtime and reset stale rates on disconnect.
- Confirm dialogs no longer leave older Promises pending; Escape and route changes cancel the active dialog.
- Empty `204 No Content` responses are handled through typed void requests instead of JSON parsing/casts.
- A late exit event from a replaced core process no longer clears the new child handle or PID record.
- Concurrent daemon starts now converge on one singleton; stale PID metadata no longer authorizes replacement or deletion of a live owner.
- Failed Core/daemon termination preserves ownership records, and corrupt PID/lock records fail closed.
- System-proxy shutdown no longer destroys a user's prior proxy/PAC configuration or overwrites third-party changes made after takeover.
- Windows proxy refresh uses the correct WinINet refresh option; GNOME `uint16` ports and automatic mode are parsed correctly.
- Release downloads enforce HTTPS, redirect host boundaries, backpressure and compressed-size limits; ZIP extraction is streamed with a hard output cap.
- Core version checks use exact tokens instead of substring matching, and controller readiness requires a non-empty version across consecutive probes.
- Core update rollback slots remain available until daemon/runtime restoration succeeds; malformed install metadata and backup-only mismatch states are rejected before execution.
- Core startup fails closed when executable and install metadata are missing, malformed or inconsistent, with an explicit `sash update --force` repair path.
- npm upgrade and browser-launch children now receive the same scrubbed environment as managed runtime children.

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
