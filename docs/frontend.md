# Frontend Architecture & WebUI Design

Sash includes a modern, zero-download web dashboard built with **Vue 3** and **Vite**, bundled directly with the npm package in `dist/ui/` and served locally by `sashd` on port `19090` (`http://127.0.0.1:19090/ui/`).

---

## 1. Zero-Download Bundling Model

Unlike dashboards requiring runtime GitHub archive downloads:
- The WebUI source lives in `web/` within the repository.
- During build (`npm run build:ui` via `scripts/build-ui.mjs`), Vite compiles assets into `dist/ui/`.
- `sashd` (`src/daemon-static.ts`) serves the pre-compiled static assets directly from `dist/ui/`.
- Local UI modifications can be placed in `<root>/ui/` to override the package-bundled assets.

---

## 2. Slate & Sky Theme System

The user interface follows a modern dark palette inspired by Slate / Zinc dark foundations with Sky-blue accents (`web/src/styles/theme.css`):

```css
:root {
  --bg-app: #030712;         /* Deep Slate Base */
  --bg-sidebar: #0b0f19;     /* Header & Sidebar */
  --bg-card: #111827;        /* Surface Cards */
  --border-card: #1f2937;    /* Subtle Micro-Borders */

  --color-primary: #0284c7;  /* Sky Blue Primary */
  --color-primary-hover: #0369a1;
  --color-accent: #38bdf8;   /* Light Sky Accent */

  --color-success: #10b981;  /* Emerald */
  --color-warning: #f59e0b;  /* Amber */
  --color-danger: #f43f5e;   /* Rose */
}
```

---

## 3. Architecture & Views

```
web/src/
├── api/
│   └── index.ts             # REST client & WebSocket stream managers
├── components/
│   └── Icon.vue             # Feather icon SVG component
├── stores/
│   └── index.ts             # Reactive Pinia-like store
├── styles/
│   └── theme.css            # CSS design tokens and component utility classes
├── types/
│   └── index.ts             # TypeScript interfaces for Core & Daemon APIs
├── views/
│   ├── OverviewView.vue     # Live traffic speeds, outbound mode, active proxy details
│   ├── ProxiesView.vue      # Proxy group selector, node cards, latency testing
│   ├── SubscriptionsView.vue# Subscription import, update, node metadata
│   ├── ConnectionsView.vue  # Active connections table, source/destination inspection
│   ├── RulesView.vue        # Active routing rules inspection
│   ├── LogsView.vue         # Live real-time core log streamer
│   └── SettingsView.vue     # Listener ports, TUN toggle, Allow-LAN, core reboot
├── App.vue                  # Top navigation bar, live speed monitors, view router
└── main.ts                  # Application entrypoint
```

---

## 4. API Client & Real-Time Streaming

`web/src/api/index.ts` communicates directly with `sashd` on loopback:

- **Supervisor APIs**: `/sash/status`, `/sash/proxy/*`, `/sash/subscription`, `/sash/settings`.
- **Core APIs**: `/core/start`, `/core/stop`, `/core/restart`, `/core/config/reload`.
- **Reverse-Proxied Core APIs**: `/core/api/configs`, `/core/api/proxies`, `/core/api/connections`, `/core/api/rules`.
- **WebSocket Streaming**:
  - `api.connectTrafficStream(callback)` connects to `ws://127.0.0.1:19090/core/api/traffic` for live up/down speeds.
  - `api.connectLogsStream(callback)` connects to `ws://127.0.0.1:19090/core/api/logs` for live logging.

---

## 5. Security & Zero-Configuration Access

- **Loopback Trust**: Access from `127.0.0.1` requires no authentication modal or user credentials.
- **Hidden Internal Secret**: The browser never handles the underlying core API secret; `sashd` injects the secret server-side when proxying requests to `/core/api/*`.
- **Clean URLs**: `sash web` opens `http://127.0.0.1:19090/ui/` with no query parameters or hash credentials.
