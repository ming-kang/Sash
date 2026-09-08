# Frontend Architecture

Sash retains its Vue 3 / Vite WebUI, built into `dist/ui/` and served by the daemon. Existing LXGW WenKai Lite font assets, appearance and Unicode-range splitting remain unchanged. No framework replacement or new UI/state framework is introduced.

## State ownership

`stores/state.ts` is the single shared shallow-reactive state. Large collections are replaced by reference. `stores/index.ts` only exports the public actions/selectors; it is not another state store.

| Module | Responsibility |
| --- | --- |
| `stores/runtime-actions.ts` | Non-overlapping status polling, boot changes and settings actions |
| `stores/profile-actions.ts` | Saved profile mutations and metadata refresh |
| `stores/core-actions.ts` | Independent Core resource loads and mode/node/connection controls |
| `stores/state-ownership.ts` | Request generations, runtime identity and pure selectors |
| `stores/telemetry.ts` | Traffic history and batched, bounded log records |
| `api/session.ts` | One-time bootstrap, per-tab session and daemon identity |
| `api/index.ts` | Shared daemon client, Core queries and streams |

Three values determine refresh ownership:

- `daemon.bootId`: a new daemon invalidates old authorization and metadata revision comparisons.
- `revisions.profiles`: saved-state changes refresh profile metadata. It does not invalidate Core resources.
- `revisions.runtime`: with `bootId`, identifies the Core runtime. Replacement clears Core resources, traffic and manual latency results.

Each resource has its own loaded flag and error. A failed rules query does not discard working node data. Failures for the same runtime retain prior data and show degradation; a new runtime cannot inherit old data. Per-domain request generations discard late successes and errors. Mutation results from a replaced daemon/Core cannot overwrite its successor.

## Refresh and performance

Status polls every two seconds after the previous cycle finishes. Hidden or unauthorized tabs use a slower interval; returning to the foreground refreshes promptly. Session initialization runs on entry/reconnect, with public status boot identity detecting daemon restarts.

| Visible page | Core requests |
| --- | --- |
| Overview | Config/mode and proxies approximately every third cycle; connections approximately every fifth cycle |
| Connections | Connections each cycle |
| Rules | Rules on entry/runtime change, then cached |
| Profiles / Settings | No background Core tables |
| Logs | Log stream while visible |

Entering a page loads its resources immediately. Profile saves only refresh management metadata. Explicit Apply refreshes the resources visible after Core replacement. Traffic is one shared stream for visible consumers; traffic/log sockets pause when the page is hidden or the runtime/session is unavailable.

Existing optimizations remain: async route/editor chunks, shallow collections, collapsed node groups unmounting their cards, paginated connections/rules, separate manual latency results, and roughly 100 ms log batches capped at 600 rows. Font slices load only for rendered glyph ranges.

## Views and shared controls

`App.vue` owns the shell, route composition, session gate, global pending-configuration bar and stream lifetime. Existing Overview, Profiles, Logs, Connections, Rules and Settings pages remain.

`CoreControls.vue` and `useCoreControl()` share busy state and Apply/start/stop actions across the Overview, Settings and pending bar. Applying while running asks for confirmation because it restarts Core. Stopping Core keeps management open.

Profile selection and edits are saved first. The pending bar indicates that the running configuration differs. Overview displays the applied profile/port; Profiles shows the saved selection. The YAML editor submits the content revision read on open, preventing another tab's later edits from being overwritten. The raw `sash.json` editor is removed.

Settings drafts remain local until Save and survive status polling. A saved port/LAN change waits for Apply. The system-proxy switch performs its own operation and remains available for recovery when Core is stopped. The login-startup card uses the observed OS registration and explicit enable/remove actions.

`PageHeader`, `ProxyGroupSection`, the shared code editor, pagination, confirmation service and focus/scroll-lock composables remain reusable building blocks. Light/dark themes, Chinese/English copy and mobile navigation are retained. There is no generic table framework or event bus.

## Authorization and transport

`src/contracts.ts` and `src/sash-client.ts` define the browser-safe daemon protocol. Runtime imports do not pull Node-specific implementations into the browser. Core types describe only the data the UI uses.

The browser consumes and immediately removes the private handoff fragment, exchanges it once, and stores its session with the issuing daemon identity in `sessionStorage`. Concurrent initialization shares the exchange; storage denial falls back to memory. Old responses cannot resurrect or revoke a newer session. A bare URL shows connection instructions and never gains control through public health.

Core HTTP requests carry `X-Sash-Token`; streams use private WebSocket subprotocol authentication. The daemon replaces these credentials with its internal controller bearer. Frames require finite nonnegative counters or known textual log records. Each stream owns one reconnect timer and ignores frames from older runtime generations.

## Development and verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
node --import tsx scripts/ui-verify.mts
node --import tsx scripts/profile-ui-verify.mts
node --import tsx scripts/web-auth-ui-verify.mts
node --import tsx scripts/autostart-ui-verify.mts
```

The browser scripts use isolated data, non-default ports and fake Core/OS adapters in Chromium and Firefox. The main script checks saved/applied state, authentication, font loading, request counts and layouts with 300 nodes, 10,000 rules and 500 connections. Other scripts retain focused profile, private-file authorization and autostart interaction coverage. These are behavioral checks, not a real-Core CPU/memory benchmark.

For local source development:

```sh
node scripts/dev.mjs web
node scripts/dev.mjs build    # rebuild UI, then refresh the page
node scripts/dev.mjs stop     # before loading backend changes
node scripts/dev.mjs web
```

The launcher uses a separate `-dev` data directory and initial ports `18890`, `18990`, `28990`. `SASH_DEV_HOME` selects another absolute directory. It passes development defaults to the daemon without writing settings itself. `web` starts management only; `restart` applies configuration to Core. A backend code change requires stopping and starting the daemon.

The font build continues to use `cn-font-split`, native subsetter `default@7.6.8` and the scoped `koffi: 2.16.3` override. Install the native subsetter explicitly when dependency lifecycle scripts are disabled. Bundled Vue/Remix Icon licenses remain in `THIRD_PARTY_NOTICES.md` and `docs/remix-icon-license.txt`.
