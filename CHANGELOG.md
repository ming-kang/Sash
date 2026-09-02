# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Cross-platform CLI lifecycle for installing, starting, stopping, restarting, inspecting and logging the managed runtime.
- First-run Core bootstrap, transactional Core updates, npm self-upgrade command and managed configuration commands.
- Platform-conventional private data directories with an absolute `SASH_HOME` override.
- Non-detached Core supervision with PID identity verification and conservative, fail-closed termination.
- Built-in Vue 3 dashboard is bundled in the npm package under `dist/ui/`, with no runtime dashboard download.
- WebUI includes Chinese and English localization with a Settings-page language switcher.
- Dedicated `sash proxy on|off|status` commands manage explicit OS system-proxy ownership and recovery.
- Immutable `SettingsService` coordinates shared daemon/offline settings candidates, config validation and durable settings/config publication.
- Local profile library under `<root>/profiles/`: one timestamp-named YAML file per profile plus `index.json` metadata, active selection, provider update interval, quota/expiry data and persisted update errors.
- WebUI Profiles page with URL download, clipboard paste, local YAML import, Update All, profile cards, active selection, quota display and delete confirmation.
- Profile daemon API: list/add/import/activate/update/update-all/delete endpoints and scheduled due-profile refresh.
- Shared daemon/profile API contracts used by the server client and WebUI.
- State-changing daemon requests now accept the persistent CLI bearer or a per-boot WebUI token, with loopback Host validation.
- WebUI store/confirm regression tests and a minimal happy-dom Vue mount behavior harness are included in the normal Node test runner.
- Exact generated configurations are validated by the installed Core in an isolated temporary file before profile/config state is committed.
- One-time, crash-recoverable import of a qualifying pre-profile `config.yaml` into an active local profile, with conservative default-config detection and fail-closed validation.
- Versioned `sash.json` runtime schema with strict field validation and explicit v0 migration.
- Atomic daemon/start/runtime/mutation/settings leases for single-instance and cross-process state ownership.
- Durable first-install Core publication journal with publishing/committed crash recovery.
- Durable Core update journal recording previous/target install records and prepared/swapped/health-verified phases, including deferred health validation for stopped runtimes.
- Authenticated maintenance shutdown API returning an atomic Core-running snapshot for executable updates.
- Durable system-proxy ownership journal that snapshots and conditionally restores prior manual/PAC state.
- Windows/macOS/Linux and Node.js 24 CI matrix covering lint, tests, builds and actual tarball pack/install/CLI/UI smoke.
- Unified third-party notices for bundled Vue/Remix Icon assets and the separately downloaded runtime Core.

### Changed

- `sash restart` now restarts the whole runtime: the daemon exits through its serialized maintenance shutdown boundary and a freshly spawned daemon (running the installed code) starts the Core. Core-only restarts remain available from the dashboard. The daemon/Core maintenance-shutdown orchestration is shared between restart and Core updates.
- TUN privilege guidance now points at an elevated full `sash restart` instead of a stop/start sequence, since an elevated restart replaces the unprivileged daemon.
- Pre-release metadata is marked private, source installation is documented explicitly, and the unreleased `0.1.0` history is consolidated under `[Unreleased]`.
- amd64 Core downloads now prefer the upstream broadly compatible x86-64 build, with v1 and the x86-64-v3 plain asset used only as availability fallbacks.
- WebUI functional iconography now uses tree-shaken Remix Icon line components behind the existing semantic icon API.
- Built-in WebUI now uses a flat, neutral Light/Dark console with a wide text navigation sidebar, compact settings and data rows, accessible controls, responsive mobile navigation, and a two-column Overview workspace that keeps common controls beside its mode-driven proxy panel.
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

- Windows system-proxy ownership no longer fails on real `reg query` responses: the strict parser now accepts the flush-left subkey listings that follow a whole-key query, while still rejecting unrelated or malformed output.
- Windows system-proxy enable/restore no longer writes or verifies the legacy flat `AutoDetect` value. Windows rewrites it from the `DefaultConnectionSettings` blob on WinINet refreshes, so managing it made every enable fail verification and roll back; it is now observed but unmanaged, and excluded from ownership equivalence. PAC (`AutoConfigURL`) handling is unchanged.
- WebUI text and control contrast now meets WCAG AA in both themes: light-theme accent, selection, success, muted, info, danger and chart colors are deepened (white-on-accent text was ~3:1), dark-theme accent surfaces use dark text, and the off-state switch track keeps a >= 3:1 boundary against app backgrounds; `scripts/contrast-check.mjs` recomputes the ratios.
- The Logs page sizes its panel with flexbox instead of viewport arithmetic, eliminating the nested double scrollbar, and scrolls to the latest entry when the page opens.
- Proxy node cards no longer clip keyboard focus outlines, the profile quota bar exposes an accessible name, dialog/toast buttons declare `type="button"`, and network settings controls are disabled while the daemon is offline.
- WebUI core version display, TUN status badge and restart-with-confirmation logic now live in one shared composable instead of being copied across views; unused icons, types and exports were removed.
- Test subprocesses force loopback into `NO_PROXY`, preventing local HTTP fixtures from traversing a developer's configured proxy or live runtime.
- Package verification now rejects empty/missing UI output and forbidden source/test/user/secret/binary paths, installs the actual tarball, exercises its bin shims and resolves its installed UI; Windows force-termination identity revalidation is covered through injected signals instead of being skipped.
- `sash logs -f` now waits for delayed files, follows bounded appends across truncation and identity-changing rotation, and cleans up watchers/timers on SIGINT or SIGTERM; `-n` rejects non-canonical, fractional, prefixed and overflowing values.
- CLI status now preserves unknown daemon/Core/proxy/TUN values as `null`, exposes a versioned JSON observation contract, uses exit code 2 for incomplete reads, avoids success output for unresponsive daemons and limits TUN privilege guidance to verified runtime states; proxy status separates desired, daemon-applied and OS-observed values.
- WebUI now keeps daemon reachability, profile revisions and Core snapshot ownership independent: same-owner Core API failures preserve and mark stale data, new owners clear stale snapshots, stopped profile revisions still refresh, malformed stream frames are dropped and mixed-port drafts can be reverted/reset against committed settings.
- Release downloads now enforce one absolute budget across mirrors, redirects, headers and streaming bodies; continuously dripping responses cannot keep updates alive indefinitely.
- Core config reload now sends `force=true` in the upstream query contract instead of an ignored JSON field.
- Subscription redirect classification now handles IPv4-compatible/mapped/translated, NAT64, 6to4, ULA, link/site-local, multicast and documentation IPv6 ranges without overblocking unrelated public IPv4 `/16`s.
- OS proxy/process-inspection helpers now share the scrubbed child environment; Windows/macOS system tools use trusted absolute paths and Linux helper lookup ignores relative PATH entries.
- Durable rename/remove operations retry Windows sharing violations without deleting caller-owned sources, and startup restores an interrupted `.unlock-probe` or fails closed while preserving conflicting files.
- Profile and settings publications now recheck exact stored-content SHA-256 snapshots under the commit boundary, retry one settings preparation conflict, and reject stale fetches/errors instead of overwriting newer profile content.
- Profile/index reads now require bounded regular files, remote update intervals are bounded, and ID allocation avoids both metadata entries and orphan YAML files.
- Daemon JSON endpoints now reject malformed or non-object bodies with 400, oversized bodies with 413, and aborted streams without leaking TypeErrors or leaving parsers pending.
- Dashboard responses now deny framing through CSP and X-Frame-Options, preventing cross-origin UI redressing from driving authenticated local controls.
- WebSocket proxy ownership now starts before the upstream handshake, so a client disconnect aborts the pending Core request and transport instead of leaving an idle upstream stream.
- All HTTP requests entering the Core controller gateway now require daemon authentication, including GET/HEAD/OPTIONS, and browser mutations reject non-loopback Origins.
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
- Failed Core updates restore both the previous binary and install record; updates performed while Core is stopped retain `.bak` until the next managed start passes health/version checks, then commit or roll back deterministically.
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
