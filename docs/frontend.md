# Frontend Architecture & WebUI Design

The WebUI is a Vue 3 application built with Vite and bundled into `dist/ui/`. sashd serves it at `http://127.0.0.1:19090/ui/`; `<root>/ui/index.html` can override the bundled dashboard.

---

## 1. Build and Quality Gates

- `npm run build:ui` calls the Vite Node API through `scripts/build-ui.mjs`.
- `npm run typecheck:web` runs `vue-tsc`, including Vue templates.
- `npm test` runs server type checking, WebUI type checking, backend tests and WebUI TypeScript tests.
- Biome checks WebUI TypeScript and Vite configuration. Vue templates are type-checked by `vue-tsc` and compiled by Vite.
- Vite 6 is used so repository builds support the full declared Node.js 20 baseline.

---

## 2. Source Layout

```text
web/src/
├── api/index.ts                  typed REST client and WebSocket reconnect logic
├── components/
│   ├── AppSidebar.vue
│   ├── ConfirmDialog.vue
│   ├── ProxyGroupSection.vue     reusable group header/node grid
│   ├── TrafficChart.vue
│   └── ...
├── i18n/                         Chinese source messages and typed English mirror
├── stores/index.ts               runtime state, refresh actions and polling
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
└── router.ts                     small hash router
```

Daemon/profile contracts live in `src/contracts.ts` and are imported as types by both `src/daemon-client.ts` and the WebUI. This prevents manually duplicated `SashStatus` and profile response shapes.

---

## 3. Runtime State Ownership

`web/src/stores/index.ts` owns status, profiles, proxy groups, rules, connections, traffic history, logs and toasts.

Canonical actions include:

- `refreshStatus()`
- `refreshConnections()`
- `refreshProxies()`
- `refreshProfiles()`
- `refreshRuntimeState()`
- `startRuntimePolling()`

Polling is self-scheduling with `setTimeout` after the previous cycle completes, so requests cannot overlap and an older response cannot overwrite a newer snapshot. Each cycle refreshes the daemon boot token, allowing controls to recover after sashd restarts. Core-specific API calls are skipped when the core is stopped.

Views call store actions rather than maintaining separate copies of status/proxy/rule refresh orchestration.

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

The Overview proxy panel uses `ProxyGroupSection.vue` for manual, automatic and GLOBAL groups. This keeps node-card rendering, delay labels, UDP/current markers and group test controls in one component. Group and node latency tests track independent in-flight sets, so tests for different groups/nodes can run concurrently.

---

## 5. API and Streaming

`web/src/api/index.ts`:

- distinguishes JSON and `204 No Content` endpoints through overloads rather than `undefined as T`;
- reads an error response body once and surfaces JSON or plain-text messages;
- parses WebSocket frames separately from consumer callbacks, so callback errors are not mistaken for malformed JSON;
- maintains at most one reconnect timer per stream;
- sends `X-Sash-Token` on HTTP requests after initialization.

Streams:

- `api.connectTraffic(callback)` → `/core/api/traffic`
- `api.connectLogs(callback)` → `/core/api/logs`

The controller secret is never available to browser code; sashd injects it server-side.

---

## 6. Interaction State

- Settings keep a local dirty flag so background polling does not overwrite a port currently being edited.
- Logs receive monotonic IDs before entering the capped 600-row buffer, providing stable Vue keys and an update sequence even when length remains constant.
- The global confirm service settles a previous pending Promise before opening another dialog; Escape, route changes and component unmount cancel the active confirmation.
- Runtime refresh failures keep prior useful data where possible and drive the global offline banner.
