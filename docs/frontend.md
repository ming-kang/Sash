# Frontend Architecture

Sash's Vue 3 / Vite dashboard is built into `dist/ui/` and served by Sash. LXGW WenKai Lite fonts use Unicode-range splitting.

## State ownership

`stores/state.ts` holds shared shallow-reactive state. Large collections are replaced by reference. `stores/index.ts` exports the public actions and selectors.

| Module | Responsibility |
| --- | --- |
| `stores/runtime-actions.ts` | Status adoption, boot changes and settings actions |
| `stores/runtime-events.ts` | Authenticated status subscription, reconnect and visible Core resource scheduling |
| `stores/profile-actions.ts` | Saved profile mutations and metadata refresh |
| `stores/core-actions.ts` | Independent Core resource loads and mode/node/connection controls |
| `stores/telemetry.ts` | Traffic history and batched, bounded log records |
| `api/session.ts` | One-time bootstrap, per-tab session and daemon identity |
| `api/index.ts` | Shared daemon client, Core queries and streams |

Three values determine refresh ownership:

- `daemon.bootId`: identifies the running Sash process and resets metadata revision comparisons when it changes.
- `revisions.state`: saved-state changes refresh profile metadata. It does not invalidate Core resources.
- `revisions.runtime`: with `bootId`, identifies the Core runtime. Replacement clears Core resources, traffic and manual latency results.

Each resource has its own loaded flag and error. A failed rules query preserves working node data. Failures retain prior data and show degradation; Core runtime changes clear its collections and telemetry.

## Refresh and performance

Authorized tabs receive full status snapshots through `/sash/events`. Entry and reconnection validate the daemon identity and restore or continue the private session. A new stream starts with a complete snapshot. Unauthorized tabs probe slowly for availability; a new browser handoff connects immediately.

Core resource snapshots retain a separate, non-overlapping two-second schedule while visible. They pause in hidden tabs and refresh promptly on return. Metadata reads retry independently when their observed revision could not be loaded.

| Visible page | Core requests |
| --- | --- |
| Overview | Config/mode and proxies approximately every third cycle; connections approximately every fifth cycle |
| Connections | Connections each cycle |
| Rules | Rules on entry/runtime change, then cached |
| Profiles / Settings | No background Core tables |
| Logs | Log stream while visible |

Entering a page loads its resources immediately. Profile saves only refresh management metadata. Explicit Apply refreshes the resources visible after Core replacement. Traffic is one shared stream for visible consumers; traffic/log sockets pause when the page is hidden or the runtime/session is unavailable.

Unchanged proxy responses retain their references; a local selection or runtime replacement invalidates that reuse. Node cards use content visibility and memoization that includes labels, selection, metadata, latency, testing and language. Group collapse choices persist locally, with only the first four groups expanded by default. Connection rows include visible metadata and relative time in their memoization keys; paused snapshots and busy sets remain shallow.

Routes and the editor display loading, failure and reload states. Pagination supports first/last and direct page jumps. Errors remain until dismissed; transient notices pause while hovered or focused. Brief traffic socket disconnections retain history for one reconnect interval. Log batches remain capped at 600 rows and font slices load only for rendered glyph ranges.

## Views and shared controls

`App.vue` owns the shell, route composition, session gate, global pending-configuration bar and stream lifetime for the Overview, Profiles, Logs, Connections, Rules and Settings pages.

`CoreControls.vue` and `useCoreControl()` share busy state and Apply/start/stop actions across the Overview, Settings and pending bar. Applying while running asks for confirmation because it restarts Core. Stopping Core keeps management open.

Profile selection and edits are saved first. The pending bar indicates that the running configuration differs. Overview displays the applied profile/port; Profiles shows the saved selection. The YAML editor submits the content revision read on open, preventing another tab's later edits from being overwritten.

Settings drafts remain local until Save and survive status updates. A saved port/LAN change waits for Apply. The system-proxy switch performs its own operation and remains available for recovery when Core is stopped. The login-startup card uses the observed OS registration and explicit enable/remove actions.

Views share `PageHeader`, `ProxyGroupSection`, the code editor, pagination, confirmation service and focus/scroll-lock composables. They support light/dark themes, Chinese/English copy and mobile navigation.

## Authorization and transport

`src/contracts.ts` and `src/sash-client.ts` define the browser-safe daemon protocol. Runtime imports do not pull Node-specific implementations into the browser. Core types describe only the data the UI uses.

The browser consumes and immediately removes the private handoff fragment, exchanges it once, and stores its session with the issuing daemon identity in `sessionStorage`. Concurrent initialization shares the exchange; storage denial falls back to memory. Old responses cannot resurrect or revoke a newer session. A bare URL shows connection instructions and never gains control through public health.

Core HTTP requests carry `X-Sash-Token`; streams use private WebSocket subprotocol authentication. The daemon replaces these credentials with its internal controller bearer. Frames require finite nonnegative counters or known textual log records. Each stream owns one reconnect timer and ignores frames from older runtime generations.

Daemon SSE uses `X-Sash-Token` through a streaming fetch, with credentials kept out of URLs. Frames carry a monotonic sequence, full daemon status and a desktop startup observation. Decoding is bounded, validates the shared contract and rejects a boot change or regressing sequence within a connection. Idle deadlines and cancellation release the reader before reconnecting.

## Development and verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke:ui
npm run verify:ui
npm run verify:ui:profiles
npm run verify:ui:auth
npm run verify:ui:autostart
```

All browser scripts share `scripts/ui-harness.mts` for the mock Core listener, browser launch and failure captures.

The browser scripts use isolated data, non-default ports and Core/OS fixtures in Chromium and Firefox. They cover runtime actions, profiles, authorization, start at login, fonts, layouts and stream recovery.

For local source development:

```sh
node scripts/dev.mjs web
node scripts/dev.mjs build    # rebuild UI, then refresh the page
node scripts/dev.mjs stop     # before loading backend changes
node scripts/dev.mjs web
```

The launcher uses a separate `-dev` data directory and initial ports `18890`, `18990`, `28990`. `SASH_DEV_HOME` selects another absolute directory. It passes development defaults to the daemon without writing settings itself. `web` starts management only; `restart` applies configuration to Core. A backend code change requires stopping and starting the daemon.

The font build continues to use `cn-font-split`, native subsetter `default@7.6.8` and the scoped `koffi: 2.16.3` override. Install the native subsetter explicitly when dependency lifecycle scripts are disabled. Bundled Vue/Remix Icon licenses remain in `THIRD_PARTY_NOTICES.md` and `docs/remix-icon-license.txt`.
