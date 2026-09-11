# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Simplify profile reads to return source text without parsing YAML for the editor or unchanged-content comparisons. Keep validation at save, activation and Apply; damaged source text can now be opened for repair.
- Keep one frozen committed application state instead of a mutable state plus a cached clone. Replace per-method response casts with one typed client request boundary.
- Shorten AGENTS.md while preserving safety, public API and workflow constraints; remove obsolete architecture descriptions and record the simplification ablations.

## [0.2.2] - 2026-09-10

### Fixed

- Core installs and updates no longer depend on a PowerShell 7 CPU probe that standard Windows does not ship: its silent failure denied the faster v3 build to nearly every Windows machine. The staged build is now preflighted directly (`-v`); a processor that cannot run it rejects it with an illegal-instruction exit and staging falls through to the next published variant.
- `sash status` no longer spends a PowerShell/registry round-trip probing the OS proxy state when a healthy daemon already reported it.

### Removed

- About 2,800 lines of machinery that guarded against opponents that do not exist: an inode/mtime profile cache defending against out-of-band edits of immutable files, a slow-mutation reporting rig and purpose labels threaded through three layers for no consumer, a 500ms supervisor status cache under an already-throttled event observer, a post-spawn version re-check the update transaction already closes, dead redirect dispatchers and a meaningless `manualRedirect` option at seven call sites, and — in the dashboard — request-generation counters, cross-tab ownership arbitration and optimistic-transaction rollback pointed at a single-user loopback daemon. Also gone: the one-off trace script and 17 tautological/contract-mirror tests.

## [0.2.1] - 2026-09-10

### Changed

- Install before stopping anything in `sash upgrade`. The package is now replaced while the daemon keeps running, and only then does the daemon restart onto the new code (`--no-restart` skips that step and prints the command instead). This fixes a deadlock the previous order could not survive: on a machine whose only route to the npm registry is the proxy the daemon serves — a laptop behind its own Core, which is exactly how `sash` is often used — stopping the daemon first killed the proxy and made the install impossible. A failed install no longer needs the daemon restarted on the old version, because nothing was stopped. Core is untouched either way: its binary lives in the data directory, not in the npm package.
- Report a version mismatch instead of hiding it. A daemon keeps executing the code it started with, so after any install that was not followed by a restart (manual `npm install -g`, `--no-restart`, an interrupted restart) `sash status` prints `0.1.7 running · 0.2.0 installed — run sash stop && sash start to load it`, and `sash doctor` raises the same as a warning. `--json` gains `restarted` from `sash upgrade`.

### Upgrade note

Upgrading from 0.2.0 with `sash upgrade` is fine on a normal network. If this machine reaches the npm registry only through the proxy Sash serves, 0.2.0's own updater still stops the daemon first and cannot install itself: run `npm install -g @astralyn/sash@0.2.1` while Sash keeps running, then `sash stop && sash start`. From 0.2.1 on, `sash upgrade` installs before it stops anything and works in both cases.

## [0.2.0] - 2026-09-10

### Changed

- Rewrite the CLI's user-facing wording around the user's concepts instead of the implementation's. `sash status` no longer prints the internal `desired`/`applied`/`observed` split as `proxy desired`, `daemon applied` and `os proxy`; it prints one `system proxy` line that names the next step when the two sides disagree (`on — not applied to Windows yet; run sash proxy on`, `off — Windows is still set to 127.0.0.1:18890`). The headline is `Sash is running · Core running (v1.19.30)` instead of `sashd running (PID=…), core running (PID=…)`, and PIDs move to where they help: troubleshooting lines and `--json`. `sash doctor` prints check names (`Start at login`, `System proxy`, `Windows connections`) instead of internal ids and states what to do next, and `sash auto`, `sash proxy` and the profile commands drop their own internal vocabulary (`Management started…`, `Runtime mode set to…`, `Saved profile 1757… revision 1`) for plain sentences that name the command to run. `--help` names the Core and Sash consistently. AGENTS.md gained a Copy and Vocabulary section so the next change stays consistent; JSON fields, `doctor --json` check ids and exit codes are explicitly frozen.

- Replace the self-upgrade transaction with a thin npm flow. `sash upgrade` resolves the exact release from the npm registry, stops the daemon, runs `npm install --global @astralyn/sash@<version>` from the installation prefix and starts the daemon again. The upgrade journal, startup barrier, package staging and candidate probe, shim/launcher replacement, upgrade authorization grants, HMAC-signed runtime handoffs, installation instance registry and autostart capture/apply helpers are gone, along with the `/sash/upgrade/*` routes and the daemon's upgrade reservation API.
- Stop re-validating what Sash itself produced. The CLI and dashboard type daemon responses instead of re-parsing them, settings are validated once in `settings.ts`, profile YAML is parsed once per source, the delay target is checked at the CLI and HTTP input boundaries only, and `contracts.ts` keeps only `parseApiErrorBody` (366 to 142 lines).
- Stop treating Sash's own local state as untrusted. `sash.json` is read leniently and no longer byte-compared on every mutation, the Core install record ignores its legacy `sha256` field, `state-lock.ts` reclaims dead-owner and unreadable lock files instead of blocking until the user deletes them (438 to 244 lines), and `bounded-file.ts` drops the no-follow and descriptor-identity ceremony.
- Accept the configuration the Core accepts. Subscription YAML is parsed once with a plain `YAML.parse` (no 50-alias cap), share-link detection and the `listeners:` ban are gone, subscription redirects only have to be absolute http(s) URLs, and the `proxies`/`rules` shape heuristic is gone. The Core's own pre-flight config check remains the authority; size caps remain.
- Keep browser sessions across daemon restarts. Session hashes and boot ids are written to `state/web-sessions.json` (mode `0600`) and exchanged through `POST /sash/web/continue`, replacing the signed upgrade handoff that used to carry them. Only hashes are stored, so the file alone cannot authenticate anyone.
- `sash upgrade --json` prints one result object and routes npm output to stderr; the report is `{current, target, available, compatible, supported, installation, prefix?, node, requiredNode?, reason?}` with no pending or recovery phase.
- Drop the Core runtime capture/restore path that only the upgrade handoff used: `core-runtime-state.ts`, `MihomoApi.runtimeState`/`restoreRuntimeState`, `RuntimeLifecycle.restore()` and the upgrade-only `AutostartService.repairAfterUpgrade`. Routing mode and proxy-group selections therefore reset on any restart, exactly as they already did for `sash restart`, instead of being preserved across an upgrade only.

### Fixed

- Start on a configuration that uses GEO rules on a network without direct access to `github.com`. The Core downloads its geodata databases (`geoip.metadb`, `geosite.dat`, `country.mmdb`, `GeoLite2-ASN.mmdb`) while loading a configuration, and it fetches them itself, ignoring `HTTP_PROXY` — so a first start deadlocked: no Core without geodata, and no way to fetch geodata without the Core's own proxy. The pre-flight check now recognizes a geodata download failure instead of reporting "Core rejected generated configuration", retries once with `geox-url` rewritten to the release-mirror hosts, and applies the retried configuration, which leaves the databases and a working source in the data directory. A failure after the retry says so explicitly and names the two ways out (a trusted `geox-url`, or pre-seeded files); a system-wide tunnel also works, a proxy environment variable does not.
- Let `GITHUB_TOKEN`/`GH_TOKEN` reach `sashd`, which performs Core release metadata and asset downloads. The daemon was spawned with a fully scrubbed environment, so the token support could never take effect where it was needed: with the anonymous GitHub API quota exhausted (a shared or datacenter exit IP), `sash update --check` succeeded through the token while `sash start` failed with `HTTP 403` on the same machine. Core, npm and helper children still receive no credential.

### Removed

- Delete the self-upgrade machinery (`upgrade-*.ts`, `installation-registry.ts`, `package-health.ts`, `signed-file.ts`, `daemon/upgrade.ts`, the dashboard-manifest runtime probe) and its tests, plus the now-unreachable `core-runtime-state.ts`. The bundled entries are now `cli.js`, `daemon-entry.js`, `autostart-entry.js`, `webui.js` and `installation.js`.
- Delete `docs/self-upgrade-design.md`.
- Drop the `sashUpgradeProtocol` package field.

### Upgrade note

Upgrading from 0.1.7 requires one manual `npm install -g @astralyn/sash@0.2.0`: the 0.1.7 updater verifies the target package against the removed handoff protocol and probes removed bundled entries, so it refuses this package. From 0.2.0 on, `sash upgrade` works as usual.

## [0.1.7] - 2026-09-10

### Fixed

- Keep Sash upgrades working from 0.1.3 and 0.1.4: their updater writes the runtime handoff with three extra fields and re-reads it while the transaction runs, so accept that legacy schema and keep writing it back unchanged until the handoff is cleared.

## [0.1.6] - 2026-09-10

### Added

- Keep the most recently committed manifest as `sash.json.bak` and let `sash doctor` point to it when `sash.json` is corrupt, so settings and the profile index have a recovery path.

### Changed

- Ship `dist/` as self-contained single-file bundles, one per process entry (`scripts/build-dist.mjs`). Runtime dependencies are compiled in with their license notices (`dist/*.LICENSE.md` and inline), move to `devDependencies`, and `npm audit` covers the whole tree again.
- Load CLI command modules lazily and only initialize what each command uses: `sash version` and `--help` drop from roughly 350 ms to under 100 ms of startup.
- Read the Windows login-startup registration with `reg.exe query` instead of a PowerShell host; fall back to the base64 PowerShell inspection only when the console code page would garble the value (non-ASCII profile paths).
- Replace the development-only `adm-zip` ZIP fixture writer (whose advisories cannot be resolved without reintroducing another) with `yazl`.
- Unify error-message formatting, narrow module-internal exports, give custom error classes their names, and record upgrade-access parse failures in the daemon log.
- Add unit coverage for the profile-update scheduler, dashboard session exchange, runtime event subscription and format helpers; document `sash doctor` in the README; correct the architecture note's dashboard-refresh description to SSE push.

### Fixed

- Report a specific "already in use" error including the port when another process owns the daemon port, instead of a generic startup failure.

## [0.1.5] - 2026-09-10

### Changed

- Simplify internal plumbing without changing command or dashboard behavior: one daemon client factory, one loopback request gate for HTTP and WebSocket upgrades, one credential environment list for child processes, and one signed-file helper for upgrade handoffs.
- Stop re-validating daemon-owned response bodies in the CLI and dashboard. Identity, browser credential, upgrade handoff and daemon status boundaries keep their checks.
- Resolve Core release metadata (tag, assets and compatible asset names) in one place for both update checks and downloads.
- Fold test helpers out of the collected test glob, start mock Core servers through the shared harness, and keep one upgrade recovery case per recovery path instead of the full boundary matrix.
- Share one harness across the browser verification scripts, wire them as `npm run verify:ui*`, and drop the orphaned contrast script. Dialog scroll locking now lives with the focus composable.
- Drop unused helpers (`tailFile`, the mutation queue status field) and single-use autostart modules; report one line of error detail from a single formatter.
- Update the architecture notes to describe the retained `sash upgrade` behavior.

## [0.1.4] - 2026-09-10

### Changed

- Check Core archive integrity once during download and trust installed files under local account permissions. Remove executable hashing and version-only digest migration from startup, updates, recovery and doctor; retain configuration validation, verified process termination and startup rollback.
- Select Core builds using CPU and OS instruction support, preferring supported v3/v2/v1 assets and using compatible/v1 when detection is unavailable. Record the selected asset and start a newly installed Core once.
- Let npm prepare Sash packages and dependencies, run one candidate probe, and track package directory identity instead of per-file hash manifests. Preserve interrupted upgrades and report leftover cleanup as a warning after restoring runtime and startup admission.
- Build one npm tarball in CI, test it on every supported platform, and publish that exact artifact from successful CI for the release commit. Separate type-checking from tests and remove duplicate local/publish acceptance steps.
- Complete all release checks before npm publication; after upload succeeds, only tag the source commit and create the GitHub Release. Remove registry polling and repeated provenance, installation and runtime verification from the publish workflow.

## [0.1.3] - 2026-09-10

### Added

- Add `sash status --delay <name>` for explicit node/group latency observations, with distinct timeout/failure states, JSON results and non-overlapping 30-second sampling with `--watch`. Ordinary status never initiates outbound tests.
- Ship PowerShell 7 completion for command paths, options and fixed choices, including quoted arguments and cursor-aware parsing without executing Sash or network requests.
- Detect additional Windows connection-specific proxy records in doctor and explain their management limits without exposing or editing the binary records.
- Add authenticated `/sash/events` snapshots and `sash status --watch`, including reconnect across daemon replacement, terminal redraw and newline-delimited status JSON without starting a stopped instance.
- Add persistent proxy-group collapse choices, latency sorting with distinct timeout/failure feedback, page jumps and first/last navigation, and recoverable dashboard chunk-loading errors.
- Add isolated Chromium/Firefox dashboard smoke checks for desktop/mobile layouts, live interactions, traffic reconnects and rendered color contrast through `npm run smoke:ui`.
- Add `sash doctor [--json]` to diagnose installation/assets, manifest corruption, Core hashes, runtime/desktop integration and listener conflicts without initializing or repairing application state. Include specific repair advice and preserve unknown observations.
- Add `sash update [tag] --check` and `--json`, with live preparation/download/verification progress from the daemon. Keep checks free of installation and management startup, and keep progress reads independent of the update result.
- Add saved-profile CLI operations (`list`, `use`, `add`, `update`, `rename`, `remove`), system-proxy controls, runtime routing modes and `sash stop --core`. Preserve explicit Apply semantics, support profile IDs or unique names and JSON results, and keep stopped profile queries free of initialization writes.
- Add `sash upgrade [version] [--check] [--json]` for complete Sash self-upgrades. Prepare and verify npm dependencies before downtime, coordinate shared instances, restore applied Core/proxy state and browser access, preserve pending edits and login startup, and recover failures or interruptions through an independent worker and durable command launcher.

### Security

- Replace production ZIP parsing with the read-only `yauzl` reader and stream validated entries with cancellation and size checks. Exclusively create extraction output so existing files, hard links and symbolic links are preserved. Keep `adm-zip` only for test archive generation; its affected extraction APIs are unused and it is absent from production dependencies.
- Disable controller redirects, strip hop-by-hop gateway headers, and expire idle browser sessions after 12 hours with sliding renewal.
- Verify release downloads while streaming, keep downloaded archives private on POSIX, and retain integrity/ownership checks throughout npm package replacement and cleanup.
- Remove alternate controller sockets/pipes and tunnels from generated configurations, and reject custom listeners before changing a running Core.
- Require authentication to read settings and profile metadata; redact subscription URLs from unauthenticated daemon status while preserving authorized CLI and dashboard access.
- Record extracted Core binary SHA-256 digests and verify installed, staged and rollback files before execution or recovery. Authenticate existing version-only records against official release artifacts before adding their digests.

### Fixed

- Resolve Windows short paths and directory aliases during registry, journal, staging and process-owner checks, including recovery while the package slot is temporarily absent; retain executable, lease, boot and authenticated API verification.
- Detect share-link subscription formats with credential-free YAML guidance, unify YAML alias limits and preserve unknown empty provider quota fields.
- Serve dashboard bodies and lengths from one file descriptor, close it on HEAD/disconnect, explain missing UI assets and include the manifest path in state-read failures.
- Try both installed PowerShell hosts for WinINet notification, retain verified registry changes with actionable fallback guidance if notification is unavailable, and allow 20 seconds for antivirus scanning during a new Core binary's first verification.
- Cancel CLI stream readers before normal exit when their output pipe closes, avoiding a Windows Node assertion during forced exit while retaining exit code `0`.
- Preserve traffic history through brief WebSocket reconnects, keep errors readable until dismissed, pause transient notices on hover/focus, and show snapshot failures without requiring hover.
- Use accessible theme colors for secondary buttons and connection tags, expose sort/toggle state to assistive technology, and reflect profile-update exclusion in card controls.
- Capture log tail and follow position from the same open file to avoid repeated lines during append/rotation, clean up backpressure listeners on cancellation, and exit successfully when the CLI output pipe closes.
- Distinguish a new Core start from an already-running instance and print its actual applied port while saved edits remain pending.
- Keep installation discovery consistent during atomic instance publication and concurrent unregister, so a recovering upgrade does not mistake temporary files for unknown owners.
- Retry installation lock acquisition when another owner releases between contention and inspection, without deleting another attempt's temporary file.
- Keep mirror download progress monotonic and preserve Windows process paths containing Unicode during identity inspection.
- Recheck process liveness before treating a stale process-census entry as an unidentified upgrade owner, and preserve subprocess JSON error details in upgrade diagnostics.
- Keep runtime routing-mode requests outside the application mutation queue and reject missing or changed Core ownership.
- Preserve HTTP status errors when controller, release or subscription error bodies are oversized or unreadable, and stop release lookup fallback after cancellation.
- Keep all CLI logs readable when settings are corrupt and separate long status labels from their values.
- Distinguish warning logs from errors, count live connections in paused close-all controls, label connection sorting correctly, and allow longer group latency tests in the dashboard.

### Changed

- Reuse frozen parsed profile sources in a bounded per-daemon cache with file-identity invalidation; periodically prune recognized orphan/temp files after a 24-hour grace period while preserving active, recent, unknown and linked paths.
- Replace dashboard status polling with authenticated SSE, share daemon observations across subscribers, bound slow-client buffers and keep desktop startup checks from delaying runtime progress.
- Reuse unchanged proxy snapshots without hiding local selections or runtime replacement, memoize visible node/connection content, and keep large paused snapshots and busy sets shallow.
- Trim unused dashboard icons, theme helpers and translations; annotate the official icon package's factories during builds so unused icons are removed. Reduce first-load JavaScript from about 2.74 MB to 200 KB.
- Select Core release tags through the positional `sash update [tag]` argument instead of the ambiguous `--version` option; stop route matching at the first compatible route while preserving method-mismatch metadata.
- Run independent CLI status probes concurrently, expose JSON login startup status and management-start notices, and scope CLI stack traces to `SASH_DEBUG` with documented bare-command and exit-code behavior.
- Add authenticated upgrade reservations and private runtime handoffs. Preserve applied configuration, routing mode, node selections, proxy ownership and pending edits across controlled daemon replacement; exchange browser sessions only through a bounded upgrade continuation.
- Report the daemon's startup Sash version and installation identity, and register its data directory under a shared installation startup gate for coordinated upgrades.
- Back off failed scheduled profile updates, share in-flight updates across manual and scheduled callers, and keep profile downloads running when only Core is stopped.
- Expose active and queued daemon mutations with slow-operation diagnostics; share short-lived status probes while keeping safety decisions fresh and requiring authentication for forced probes.
- Cache immutable application snapshots per commit, expose saved-state revisions as `revisions.state`, and reject stale settings writes using `expectedRevision`. Keep status values consistent with their revision across slow probes.
- Automate release finalization in the publish workflow: verify published provenance on every run, smoke-test the registry package with a real Core on Windows, then tag the release commit and create the GitHub Release from its changelog section.
- Update dependencies: commander 15 and undici 8 (download and controller dispatchers stay on HTTP/1.1); build the dashboard with Vite 8 and @vitejs/plugin-vue 6.
- Remove the TUN and service-mode development-branch references from README and docs; TUN stays disabled in generated configurations and is no longer planned.

## [0.1.2] - 2026-09-08

### Added

- Add Windows login startup through `sash auto [on|off|status]` and the dashboard settings. Preserve the selected data directory and report stale or OS-disabled entries; bare `sash auto` reads status.
- Record login startup attempts and failures in a private rotating log, readable with `sash logs --startup` even when settings are invalid.
- Add a source development launcher with separate data and ports, plus a `build` command for the WebUI.
- Reorder profile cards with a long press and drag or Alt + Up/Down. Persist the order across dashboard refreshes without changing the active profile or reloading Core.

### Changed

- Make the daemon the only application state writer. Replace offline mutation, maintenance handoff and coordinated profile/Core transactions with one in-memory mutation queue.
- Store settings, profile metadata and selection in one atomic schema-2 `sash.json`; store profile sources as immutable `<id>/<revision>.yaml` files. No old-format or API migration is provided.
- Separate saving from applying. Profile edits, selection, scheduled updates and network preferences stay saved until Apply or `sash restart`; failed application preserves saved edits.
- Make `sash web` start management without Core, and make `sash restart` replace Core while retaining the daemon and browser sessions.
- Narrow Core updates to executable/install metadata. First installs and updates always complete health verification immediately, including a temporary start when initially stopped; retain rollback files until verification and runtime restoration succeed.
- Keep Vue, the existing WebUI and LXGW WenKai Lite font. Share Core controls, refresh Core resources independently by visible page, and retain caches and latency results across metadata edits.
- Remove TUN product fields, non-Windows desktop integration, raw settings editing in the dashboard, configuration reload aliases, `sash upgrade` and `sash update --force`.

### Fixed

- Cancel pending downloads and configuration validation on stop/shutdown; prevent stale responses from changing a replacement runtime.
- Wrap long proxy node names across the full card width and keep latency controls on the metadata row.
- Make profile card padding and unused space clickable while keeping rename, edit, update and delete actions independent.

## [0.1.1] - 2026-09-08

### Fixed

- Start a stopped Core update from its already validated configuration before normal profile publication, preserving coordinated rollback until the health check succeeds. This also fixes first startup after installing Core with `sash update`.
- Authorize dashboard HTTP and WebSocket control through private, single-use browser handoffs; keep credentials out of public health responses and preserve sessions across page refreshes.
- Keep the recovery dashboard available when Core startup fails without authorizing competing starts from unknown runtime observations.
- Fix native Windows log watching, clean font builds, temporary-directory aliases, private browser-handoff file checks and cross-platform test timing.
- Retry ownership-safe system-proxy cleanup when an explicit disable request repeats the saved off state.
- Preserve original transaction errors after successful rollback, retain causes on incomplete rollback and report stale settings snapshots as conflicts.

### Added

- Publish verified npm artifacts through GitHub Actions trusted publishing, with provenance and registry-install checks.
- Add an npm release runbook, external package smoke checks and dependency update configuration.

### Changed

- Defer TUN and Windows Service Mode to the `feat/tun-service-mode` development branch. This release provides local HTTP/SOCKS endpoints and system-proxy controls, with no TUN or service administration controls.
- Migrate enabled legacy TUN settings to off, reject new enable requests and explicitly disable TUN in generated configurations. Preserve original profile files and DNS/provider options; reject separate TUN listeners before publication.

## [0.1.0] - 2026-09-05

### Added

- The daemon HTTP API now has a shared browser-safe `SashClient` (`src/sash-client.ts`) covering the whole `/sash/*` surface with strict contract parsers; the CLI daemon client and the WebUI both build on it.
- The Settings page now has an "Edit settings file" button (top right, next to the header) that opens the full `sash.json` in a CodeMirror JSON editor. Saves are validated strictly — invalid JSON, unknown fields, port conflicts and non-loopback controllers are rejected without touching the disk — and changed managed keys are applied through the existing settings transaction machinery (core restart included where required). `daemonSecret` changes hot-swap immediately; `daemonPort` changes are persisted and the UI reminds the user that they take effect after a manual `sash restart`.

- Profiles can be renamed from the WebUI: a pencil button on each profile card opens a rename dialog backed by the new `PATCH /sash/profiles/:id` daemon endpoint. The rename touches only the profiles index (`profiles/index.json`) — the YAML file name is the timestamp id and the name never enters the generated core config, so no core reload is needed. Subscription updates keep the user-chosen name (matching Clash Verge Rev's behavior). The profile content editor button now uses a `</>` icon to distinguish it from rename.

- Cross-platform CLI lifecycle for installing, starting, stopping, restarting, inspecting and logging the managed runtime.
- First-run Core bootstrap, transactional Core updates, npm self-upgrade command and managed configuration commands.
- Platform-conventional private data directories with an absolute `SASH_HOME` override.
- Non-detached Core supervision with PID identity verification and conservative, fail-closed termination.
- Built-in Vue 3 dashboard is bundled in the npm package under `dist/ui/`, with no runtime dashboard download.
- WebUI includes Chinese and English localization with a Settings-page language switcher.
- Running `sash` with no arguments prints the same output as `sash status`.
- The system proxy is toggled from the dashboard or `PATCH /sash/settings`; there is no separate `sash proxy` command.
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

- Daemon HTTP API reorganized into three namespaces: `/sash/*` is implemented by sashd, `/core/api/*` is the authenticated reverse proxy to the Core controller, and `/ui/*` serves the dashboard. Root-level aliases and the `/core/start|stop|restart|config/reload` paths are removed: Core lifecycle moved to `/sash/core/*`, health/status to `/sash/daemon/*`, and the two shutdown endpoints merged into `POST /sash/daemon/shutdown` returning `{ coreWasRunning }`. Success bodies no longer carry `ok` envelopes (empty successes answer 204), errors use a unified `{ error: { code, message } }` envelope with a fixed code set (`invalid_input`, `not_found`, `conflict`, `core_unhealthy`, `shutting_down`, `unauthorized`, `http`, `internal`), and 405 responses derive `Allow` from the route table.
- `PATCH /sash/settings` now takes a typed partial object (`{ mixedPort?, allowLan?, tun?, systemProxy?, daemonPort?, daemonSecret? }`) instead of string key/value pairs, and the dedicated `POST /sash/proxy/enable|disable` endpoints are gone — the system proxy is toggled through the same settings transaction, with the Core health check enforced inside `SettingsService.apply()` and reported as `409 core_unhealthy`.
- Any request carrying a non-loopback `Origin` header is rejected with `403 unauthorized`, not only mutations; WebSocket upgrades already behaved this way.
- WebUI page headers are unified: every page now uses the shared `PageHeader` component — an 80px bar matching the sidebar traffic panel whose bottom rule spans the full content width via a `--page-gutter` CSS variable. The Logs and Connections pages migrated from their bespoke toolbars; page-specific controls (search, filters, buttons) go through the component's actions slot. The mixed-port input no longer right-aligns its value.
- WebUI typography now embeds a bundled WOFF2 font (declared via `@font-face` with system fallbacks) and uses a coarser 12/14/16/18/20/24/26px size scale for readability.
- The embedded LXGW WenKai Lite font is now split at build time into 232 unicode-range WOFF2 chunks (via `cn-font-split`, wired in as a Vite plugin): the browser downloads only the glyph slices a page actually renders (~470 KB on first load instead of the full 5.1 MB single file), which eliminates the visible fallback-to-LXGW font swap on dashboard open. Fingerprinted assets under `/ui/assets/` are served with `Cache-Control: public, max-age=31536000, immutable`; other static files get a bounded one-hour cache.
- WebUI first-load JS shrank from ~629 KB to ~187 KB: non-default views load as async route chunks and the CodeMirror editor stack (~416 KB) only loads when a code editor dialog opens. Static UI responses now carry `Content-Length`.
- WebUI rendering overhead is reduced across the board: the dashboard store is shallowly reactive with replacement-based updates; the log stream batches WebSocket frames (~100 ms) instead of pushing per line; connection polling and the log WebSocket only run while their pages are open; proxy group delay tests commit in a single store write; collapsed proxy groups unmount their node cards; and the rules table paginates (80 rows per page) through a shared pager component extracted from the connections page. The sidebar clock pauses in background tabs.
- WebUI consistency cleanup: dead locale keys removed, duration/relative-time strings and confirm-dialog defaults moved into the locale files, hardcoded colors and z-index values replaced by design tokens, and connection-close/profile-rename calls now go through store actions instead of views calling the API directly.
- WebUI accent color is now an indigo-violet scale (light `#5558dd`, dark `#8f91f3`) replacing the previous teal; the traffic chart's upload series is warm orange to stay distinguishable, and `scripts/contrast-check.mjs` tracks the new palette.
- Proxy node cards are fixed-width (240px) and wrap instead of stretching, and the desktop Overview page scrolls its general and proxy panes independently.
- WebUI now uses a classic compact desktop-console shell with a 25px title strip, 170px live-traffic sidebar, recessed active navigation, dense profile/proxy rows, stream-style logs, tagged connection rows and grouped settings. The intentional combined General + Proxies Overview workspace and responsive bottom navigation are preserved.
- `sash restart` now restarts the whole runtime: the daemon exits through its serialized maintenance shutdown boundary and a freshly spawned daemon (running the installed code) starts the Core. Core-only restarts remain available from the dashboard. The daemon/Core maintenance-shutdown orchestration is shared between restart and Core updates.
- TUN privilege guidance now points at an elevated full `sash restart` instead of a stop/start sequence, since an elevated restart replaces the unprivileged daemon.
- npm installation is documented as the primary install path alongside the source-checkout `npm link` flow, and the `0.1.0` history is consolidated in the changelog.
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
- The default mixed port is consistently `7890`. Installed core version is read from `state/install.json` instead of duplicated in settings.
- Core updates download and validate the staged binary before stopping the existing runtime, and commit install metadata only after health checks pass.
- Overview proxy groups share a reusable component; WebUI runtime refresh, profile mutations, mode/proxy intent and polling are organized behind a stable store facade with one reactive state source and per-domain generations. The Overview page now composes focused general/proxy panes, while latency requests own their busy sets and captured runtime generation in one composable.
- Daemon integration tests and WebUI store tests are split by domain. Shared daemon fixtures have no top-level I/O and retain centralized instance, socket, scheduler and temporary-directory cleanup.
- Daemon status exposes a per-boot monotonic profile revision so scheduled profile publications trigger one coherent WebUI runtime refresh without adding heavy requests to every poll.
- `npm test` now runs server TypeScript, `vue-tsc`, backend tests and WebUI tests. WebUI TypeScript is included in Biome checks.
- The minimum runtime is Node.js 24 across package metadata, the early CLI guard, documentation and CI. Vite continues to use its Node API; unused archive/version dependencies were removed, and published backend source maps are disabled.
- Core/proxy transitions now pass through one serialized runtime lifecycle; proxy restoration precedes deliberate Core shutdown and readiness precedes proxy apply.
- Offline mutations reload committed settings under lock and refuse uncertain daemon/orphan-Core ownership.
- Core release mirrors are transport-only: official GitHub metadata selects the release and supplies the mandatory SHA-256 digest.
- Core updates stage outside runtime ownership, then hold runtime ownership across the daemon's atomic maintenance snapshot, offline publication and runtime restoration. A second controller-vacancy check runs inside the final mutation boundary.
- Core updates retain managed profile/config rollback snapshots until the binary outcome is durable, and runtime restoration re-reads final settings while using the healthy daemon's observed port.
- CLI commands now distinguish healthy, confirmed-offline and unresponsive runtime owners. Daemon clients, status endpoints, dashboard URLs and lifecycle output use the healthy daemon's observed port, while runtime/proxy status share one local system-proxy fallback and deduplicated error aggregation path.
- Core ZIP extraction accepts only the expected upstream executable basename; npm self-upgrade versions are restricted to strict semver or safe dist-tags.
- Core updates temporarily stop the daemon, validate the staged binary/config and recover interrupted `.bak` states before publication.
- System-proxy backends preserve manual, automatic/PAC and authentication-mode fields they modify; Linux automation is explicitly GNOME `gsettings` only.
- System-proxy capture, apply, recovery and inspection now use asynchronous child processes behind one operation queue. Same-generation reads share in-flight work, normal polling uses a short cache, and `?fresh=1` bypasses only settled cache entries.
- Daemon clients and the WebUI now parse successful health, status and proxy responses from `unknown`; internal proxy observation flags are required, while missing flags from legacy daemons are normalized only at the network boundary.
- Profile and settings preparation now exposes one-shot opaque publication capabilities instead of mutable prepared-state objects or positional commit booleans. Weak settings-source snapshots and strict profile snapshots retain their distinct conflict semantics.
- Daemon HTTP and WebSocket routing now share one origin-form request-target parser and explicit route table. Known method mismatches return `405` with `Allow`, dashboard redirects preserve root queries, and WebSocket streams are explicitly GET-only.
- npm packages now include `docs/`, lint is part of `prepublishOnly`, and package self-upgrade requires the daemon to be stopped so runtime/schema versions cannot overlap.
- The CLI is trimmed to lifecycle and diagnostics: `start`, `stop`, `restart`, `status`, `logs`, `web`, `update`, `upgrade` and `version`. Profile management, the system-proxy toggle and runtime settings moved to the web dashboard exclusively; the `sub`, `proxy` and `config` command groups were removed along with the offline-mutation paths that only served them. The `controller` and `secret` keys are now edited directly in `sash.json`.

### Fixed

- Package smoke verification now recurses into nested UI asset directories such as `dist/ui/assets/branding/` instead of asserting every top-level asset entry is a regular file.

- Proxy node delay buttons show only a spinner while testing (no "Loading…" text), and profile cards no longer wrap their meta line mid-phrase: the action buttons now overlay the card's top-right corner and the source/updated line is single-line with ellipsis plus a full-text tooltip, so it gets the whole card width.
- Profile card action buttons (rename/edit/update/delete) no longer also activate the profile through click bubbling; activation is restricted to the card's main body.
- All four WebUI dialogs now share a focus trap, Escape handling, focus return to the trigger, and a reference-counted scroll lock (previously nested dialogs could unlock page scrolling early). The two duplicated CodeMirror editor implementations are merged into a shared `CodeEditorModal` component.
- The in-app profile editor's content endpoints (`GET/PUT /sash/profiles/:id/content`) are now registered in the daemon routing table; previously the handler existed but the router returned 404 before the request reached it.

- WebUI polish: redundant RULE/current badges removed from the proxy pane and profile/node cards (the selection stripe already marks them), the group latency-test icon spins a loader instead of the lightning bolt, the Rules table is centered with column dividers and scrolls instead of paginating, and scrollbars are thin overlays that fade in while scrolling and hide when idle (including Firefox via `scrollbar-color`).
- Overview general pane: the identity header now carries version and PID, the mode buttons drop their heading, and system-proxy/LAN/TUN switches are a second row of mode-style toggle buttons (the TUN state text keeps its semantics); the port number input hides its native spinners, and the Overview restart button uses the same danger-outline warning style as Settings.
- The dark-theme Overview title now uses its intended light color: the scoped `:global()` override was being miscompiled, so `--general-title` moved into the shared theme variable blocks.
- WebUI polish: the off-state switch knob is neutral instead of red (state is now carried by the track color), Connections page pause/close buttons and connection tags use theme variables that adapt to the dark theme, the Logs page subtitle is localized, and small screens keep profile-card actions and the theme/language selectors in compact horizontal rows.
- Successful daemon health, status and proxy responses are now runtime-validated before CLI or WebUI state changes; malformed `200` payloads fail closed, and a failed WebUI initialization clears any stale per-boot session token.
- Slow Windows, macOS and GNOME proxy commands no longer block the daemon event loop. Health requests remain responsive while asynchronous status/proxy inspection is pending, and platform writes preserve their safety order.
- State-lock acquisition now treats disappearance between `lstat` and record read as a retryable missing observation instead of false corruption, with one shared decision path for synchronous and asynchronous callers.
- Core gateway routing no longer derives authentication from a parsed path but forwarding from a raw suffix. Query-only namespace roots, dot segments, encoded path data and WebSocket targets now use the same canonical representation without duplicated queries.
- Core and daemon child logs now use one private append-only descriptor helper that rejects non-regular paths, enforces POSIX `0600`, closes partial opens and cannot leak descriptors when spawn setup throws. Startup diagnostics include only bounded errors appended by the current attempt.
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
- Core updates no longer discard managed profile/config snapshots before the executable transaction is durable. Crash recovery rolls managed state back before binary/install metadata and keeps both journals when either side cannot be restored.
- `sash update --force` now journals malformed binary/install entries before moving them to fixed quarantine paths. Partial quarantine and restoration resume safely, while missing or unowned repair backups fail closed.
- Core startup fails closed when executable and install metadata are missing, malformed or inconsistent, with an explicit `sash update --force` repair path.
- npm upgrade and browser-launch children now receive the same scrubbed environment as managed runtime children.
