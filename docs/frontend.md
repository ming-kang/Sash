# Frontend Architecture & WebUI Design

The WebUI is a Vue 3 application built with Vite and bundled into `dist/ui/`. sashd serves it at `http://127.0.0.1:19090/ui/`; `<root>/ui/index.html` can override the bundled dashboard.

---

## 1. Build and Quality Gates

- `npm run build:ui` calls the Vite Node API through `scripts/build-ui.mjs`.
- `npm run typecheck:web` runs `vue-tsc`, including Vue templates.
- `npm test` runs server type checking, WebUI type checking, backend tests and WebUI TypeScript tests.
- Biome checks WebUI TypeScript and Vite configuration. Vue templates are type-checked by `vue-tsc` and compiled by Vite.
- Vite 6 builds the bundled dashboard on the declared Node.js 24 baseline.
- CI runs lint, server/WebUI type checks, all tests, production builds and actual tarball pack/install/CLI/UI smoke on Windows, macOS and Linux with Node.js 24.

The `cn-font-split` dependency has a scoped `koffi: 2.16.3` override, not a global override or Sash release-version bump. The [Koffi changelog](https://koffi.dev/changelog) documents Node.js 24.14+ teardown fixes relevant to the native font splitter. A local uncached build was validated; remote macOS CI is not yet confirmed. The temporary debug workflow/remote branch remains pending maintainer approval and remote confirmation; this is not a claim that all CI now passes.

For deterministic TUN visual checks, build current UI assets, install Playwright Chromium and Firefox, then run `npx tsx scripts/tun-ui-verify.mts`. It serves static assets on an ephemeral loopback port and mocks all APIs/WebSockets: no real daemon or Core, TUN device, OS proxy or DNS changes. It checks both engines, desktop/mobile and light/dark states, committed toggles and failed/saved-but-unverified mutations, producing screenshots and a report in a temporary directory. This verifies presentation, not real TUN connectivity.

---

## 2. Source Layout

```text
web/src/
├── api/index.ts                  typed REST client and WebSocket reconnect logic
├── components/
│   ├── AppSidebar.vue
│   ├── ConfirmDialog.vue
│   ├── Icon.vue                  semantic icon wrapper
│   ├── icons.ts                  tree-shaken Remix Icon component mapping
│   ├── ProxyGroupSection.vue     reusable group header/node grid
│   ├── TrafficChart.vue
│   └── ...
├── i18n/                         Chinese source messages and typed English mirror
├── stores/index.ts               runtime state, refresh actions and polling
├── stores/state-ownership.ts     pure generations, cleanup and sync helpers
├── styles/main.css               design tokens and shared utility/component styles
├── types/index.ts                core-controller response types; daemon types are shared
├── views/
│   ├── OverviewView.vue          status, traffic, modes and proxy groups
│   ├── ProfilesView.vue          download/import/update/select/delete profiles
│   ├── LogsView.vue
│   ├── ConnectionsView.vue
│   ├── RulesView.vue
│   └── SettingsView.vue
├── App.vue                       shell, view selection and stream lifecycle
├── theme.ts                      persisted system/light/dark theme state
└── router.ts                     small hash router
```

The shell follows a classic compact desktop-console layout: a 25px title strip sits above a 170px text-navigation sidebar with live traffic, recessed active-item geometry, runtime and Core status. Below 900px it becomes a compact title strip plus safe-area-aware bottom navigation. Light and Dark themes use flat neutral surfaces, dense rows, restrained shadows and distinct mode/semantic state colors. Profiles use a full-width download toolbar and compact profile grid; Logs use an edge-to-edge stream; Connections use colored metadata tags; Settings use labeled flat sections. Overview intentionally remains a roughly one-third/two-thirds combined General + Proxies workspace: common runtime controls and the GLOBAL/RULE/DIRECT selector stay on the left while the mode-driven proxy groups or DIRECT state render on the right. `styles/main.css` owns theme tokens, component states and reduced-motion behavior without a runtime-loaded UI dependency. Functional icons use selected, tree-shaken `@remixicon/vue` line components behind the local semantic `Icon.vue` API; the Sash brand mark remains project-owned. `THIRD_PARTY_NOTICES.md` records the bundled Vue MIT and Remix Icon notices, and the complete Remix Icon License v1.0 remains in `docs/remix-icon-license.txt`; both are included in the npm tarball. Long connection and rule sets remain paginated and switch to narrow-screen layouts.

Daemon/profile contracts live in `src/contracts.ts` and are imported as types by both `src/daemon-client.ts` and the WebUI. This prevents manually duplicated `SashStatus` and profile response shapes.

---

## 3. Runtime State Ownership

`web/src/stores/index.ts` owns status, profiles, proxy groups, rules, connections, traffic history, manual delay results, logs, operation flags and toasts. Pure ownership/generation helpers live in `web/src/stores/state-ownership.ts` and are covered by browser-free `node:test` tests. A pinned `happy-dom` dev dependency supplies the minimal DOM behavior harness for mounting a real Vue `createApp` render path and asserting reactive notice transitions; no second test runner or coverage-only gate is introduced.

Canonical actions include:

- `refreshStatus()`
- `refreshConnections()`
- `refreshProxies()`
- `refreshProfiles()`
- `refreshRuntimeState()`
- profile mutation actions such as `updateProfile()` and `activateProfile()`
- runtime intent actions such as `setOutboundMode()` and `selectGroupProxy()`
- `startRuntimePolling()`

Polling is self-scheduling with `setTimeout` after the previous cycle completes. It slows to a 15-second interval while the page is hidden and refreshes immediately after returning to the foreground. Domain request generations discard both successful responses and resource errors made stale by a newer refresh or user mutation; old polls cannot overwrite a committed settings response. Core-specific API calls are made only after status reports `running && healthy`.

Daemon reachability, profile revision and Core snapshots have separate ownership. A successful `/sash/daemon/status` keeps the daemon online even when a downstream Core gateway request returns 502. Profiles track their last fetched daemon revision independently and refresh on revision changes even while Core is stopped. A daemon restart resets that revision comparison.

The Core owner is the daemon boot plus Core PID/start time. A stopped/unhealthy Core or unreachable daemon clears proxy groups, rules, connections/totals and traffic rates/history. A same-owner Core API failure preserves the last complete configs/proxies/rules/connections snapshot, marks it degraded and retries; a changed owner clears the old snapshot before fetching, so failed replacement data cannot be shown under the new owner. Profile revision changes request a new snapshot without prematurely discarding same-owner data.

Manual latency results are stored separately from polled proxy payloads. Normal proxy polling therefore preserves a test result; a successful profile snapshot generation or Core owner change invalidates stale delay results.

Views call store actions rather than maintaining separate copies of status/proxy/rule refresh orchestration. Same-domain controls use store operation flags, while independent group/node latency tests remain concurrent.

---

## 4. Profiles and Overview Components

The Profiles page provides:

- URL download and clipboard paste
- local YAML import
- Update All and per-profile update
- active profile selection
- quota/expiry display from provider metadata
- persisted update errors
- delete confirmation

The Overview proxy panel uses `ProxyGroupSection.vue` for manual, automatic and GLOBAL groups. This keeps node-card rendering, delay labels, UDP/current markers and group test controls in one component. Group and node latency tests track independent in-flight sets, so tests for different groups/nodes can run concurrently. Mode and proxy-selection mutations are latest-request-wins and disable only their matching control domain.

System proxy controls are target-state based: enabling requires a running, healthy Core; disabling remains available when desired/applied/OS-observed state indicates cleanup may still be required, including while the Core is stopped.

---

## 5. API and Streaming

`web/src/api/index.ts`:

- distinguishes JSON and `204 No Content` endpoints through overloads rather than `undefined as T`;
- reads an error response body once and surfaces JSON or plain-text messages;
- parses WebSocket frames separately from consumer callbacks, validates finite non-negative traffic counters and known textual log records, and silently drops malformed frames;
- maintains at most one reconnect timer per stream;
- binds stream callbacks to the current runtime generation and stops stream ownership when the daemon session or healthy Core is unavailable;
- resets stale traffic rates/history when the current traffic stream disconnects without allowing an older socket's close event to clear a replacement stream;
- sends `X-Sash-Token` on HTTP requests after initialization.

Streams:

- `api.connectTraffic(callback)` → `/core/api/traffic`
- `api.connectLogs(callback)` → `/core/api/logs`

The controller secret is never available to browser code; sashd injects it server-side.

---

## 6. Interaction State

- Settings derive mixed-port dirty state by comparing the draft with the last committed value, preserve a genuinely edited draft across polling, and expose an explicit reset action. Successful `allow-lan` and TUN responses commit the returned settings snapshot directly before any follow-up refresh. TUN controls separately derive active, inactive, unverified, pending-start and desired/runtime-mismatch presentation from committed `settings.tun` plus Core health and `core.tunActive`. A running unhealthy Core is unverified, not pending start; an active listener with desired off is an unexpected-active mismatch. Active is a listener report, not connectivity/DNS or all-traffic proof. Failed online activation never advances the committed switch; failure details persist inline rather than depending only on a transient toast. Windows guidance requires explicit same-user service installation, then ordinary-user start and dashboard enable; it never suggests an elevated daemon or removed CLI TUN command. Non-Windows guidance retains manual elevated full restart with the same data root before dashboard retry. A successful mutation followed by unavailable refresh retains the committed switch and reports "saved; runtime verification unavailable" rather than pretending the save failed.
- Logs receive monotonic IDs before entering the capped 600-row buffer, providing stable Vue keys and an update sequence even when length remains constant.
- The global confirm service settles a previous pending Promise before opening another dialog; Escape, route changes and component unmount cancel the active confirmation.
- The global banner distinguishes an unreachable daemon from a degraded same-owner Core snapshot and an unavailable new-owner snapshot.

## 7. Service Mode Presentation

Settings includes a service card backed by `GET /sash/service`, showing support, `not-installed`, `ready`, `unavailable`, `incompatible` or `root-mismatch`, optional helper/Core versions and diagnostic guidance. Installation/removal are explicit administrative CLI operations, not browser elevation. Windows TUN enable is available only for a ready service and healthy Core; ready alone does not prove Core/TUN is running. Other platforms retain manual elevation guidance.

A successful daemon status with `core.running: null` and `core.queryError` keeps daemon reachability separate from unavailable service Core observation. Present this as unobserved/unverified, not daemon offline or confirmed stopped; do not stream or mutate against an unverified Core snapshot. Desired TUN remains committed intent, including after administrative uninstall. Turning it off before uninstall avoids the next direct start failing service-required; an offline daemon cannot accept the dashboard setting change (see the [operations flow](./usage.md#service-status-updates-and-removal)).

The service's private controller is never exposed to the WebUI. Sash's native bridge forwards allowed telemetry and deliberate mutations only; raw Core config/file-provider reload and upgrade routes are disabled. Profile/settings operations use the safe protected bundle publisher instead. Service Core file diagnostics are private; the healthy-Core WebSocket log stream is distinct from `sash logs` file selection.
