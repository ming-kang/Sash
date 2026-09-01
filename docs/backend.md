# Backend Architecture & Supervisor Design

Sash uses a local supervisor daemon (`sashd`) to own the core process, generated configuration, profile state, system proxy reconciliation and the HTTP/WebSocket gateway.

```text
CLI / WebUI
    │  http://127.0.0.1:19090
    ▼
sashd
├── /sash/*       settings, profiles, status, system proxy
├── /core/*       core lifecycle and config reload
├── /core/api/*   controller reverse proxy with secret injection
├── ProfileService
│   ├── profiles/index.json + profiles/<id>.yaml
│   └── transactional config generation/reload
├── CoreSupervisor
└── platform system-proxy adapter
```

The daemon binds only to `127.0.0.1`. The managed core is a non-detached child process so sashd can observe exits, clear PID state and disable the system proxy after an unexpected crash.

---

## 1. Module Boundaries

- `src/daemon.ts`: daemon assembly, lifecycle and top-level route dispatch.
- `src/daemon-profile-routes.ts`: HTTP transport for `/sash/profiles*`.
- `src/profile-service.ts`: canonical profile application service used by daemon and offline CLI paths.
- `src/profiles.ts`: synchronous profile file/index store; no network or runtime policy.
- `src/mihomo-config.ts`: untrusted YAML validation, managed-key overlay and config rendering.
- `src/supervisor.ts`: direct child process lifecycle and health checks.
- `src/daemon-proxy.ts`: controller HTTP/WebSocket reverse proxy.
- `src/daemon-auth.ts`: loopback Host validation and control-request credentials.
- `src/core-update.ts`: binary/install-record update transaction.
- `src/http.ts` / `src/github.ts`: proxy-aware remote networking and trusted download origins.
- `src/contracts.ts`: API contracts shared by the daemon client and WebUI.

---

## 2. API Namespaces

### 2.1 `/sash/*`

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/sash/health` | `GET` | Readiness probe with PID, start time and per-boot WebUI token. |
| `/sash/status` | `GET` | Daemon/core/proxy/public-settings snapshot and active profile. Secrets are omitted. |
| `/sash/proxy` | `GET` | Desired, daemon-applied and OS-reported system proxy state. |
| `/sash/proxy/enable` | `POST` | Persist and apply system proxy; core must be running. |
| `/sash/proxy/disable` | `POST` | Persist and disable system proxy. |
| `/sash/profiles` | `GET` | Return profile index. |
| `/sash/profiles` | `POST` | Download/add or update a remote profile. First profile auto-activates. |
| `/sash/profiles/import` | `POST` | Validate and import local YAML (8 MiB request limit). |
| `/sash/profiles/active` | `PUT` | Activate a profile, or pass `null` to use the default config. |
| `/sash/profiles/:id/update` | `POST` | Update one remote profile. |
| `/sash/profiles/update-all` | `POST` | Update all remote profiles with bounded network concurrency. |
| `/sash/profiles/:id` | `DELETE` | Delete a profile; deleting the active profile loads the default config. |
| `/sash/settings` | `GET` | Return public managed settings only. |
| `/sash/settings` | `PATCH` | Validate/apply a managed key and restart or reload as required. |
| `/sash/shutdown` | `POST` | Disable system proxy, stop core and close sashd. |

### 2.2 `/core/*`

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/core/start` | `POST` | Spawn the child and wait for controller health. |
| `/core/stop` | `POST` | Disable system proxy and stop the child. |
| `/core/restart` | `POST` | Stop/start the child and reconcile system proxy. |
| `/core/config/reload` | `POST` | Re-render the active profile and reload it transactionally. |

### 2.3 `/core/api/*`

Requests are forwarded to the configured controller. sashd removes daemon credentials and the browser-supplied Host header, then injects the internal controller bearer secret. `/traffic` and `/logs` upgrades are proxied as WebSockets. Upgrade requests must pass loopback Host/Origin checks and authenticate with the CLI bearer/header token or the WebUI's private `sash-token.<bootToken>` subprotocol; that credential subprotocol is stripped before forwarding.

---

## 3. Control-Request Security

- Requests with a non-loopback Host header are rejected (`421`). This prevents DNS-rebinding origins from reading the loopback API.
- `GET`, `HEAD` and `OPTIONS` are read-only/public on the loopback listener.
- Every state-changing method requires either:
  - `Authorization: Bearer <daemonSecret>` from the CLI; or
  - `X-Sash-Token: <bootToken>` from the same-origin WebUI.
- The WebUI refreshes the boot token through `/sash/health`, including after daemon restart. WebSocket streams carry it in a private subprotocol because browser WebSocket clients cannot set arbitrary authorization headers.
- HTTP and WebSocket route prefixes use segment boundaries; lookalike paths such as `/core/apiX` are not proxied.
- `/sash/status` and `/sash/settings` expose `PublicSashSettings`; controller and daemon secrets never appear in those responses.
- The controller secret stays server-side and is injected only by the reverse proxy.

---

## 4. Profile and Config Transactions

`ProfileService` is the only application layer allowed to combine network fetches, profile mutations and core reloads. Both daemon routes and offline CLI commands use it, so behavior no longer depends on whether sashd is running.

Activation flow:

1. Load and structurally validate the requested local profile file; a missing remote file may be fetched, but a missing local import is an error.
2. Render the exact candidate config with Sash-managed operational keys.
3. Write the candidate to an isolated temporary file and run the installed Core with `-t -d <root> -f <candidate>`. Rejected candidates never reach profile/config state.
4. Snapshot the current config and affected profile state.
5. Atomically write the candidate `config.yaml`.
6. Reload the running core when applicable.
7. Commit the active profile/index mutation.
8. Restore config/state and reload the previous config if any step fails.

Every Core start now reconciles `config.yaml` from the active profile and current settings instead of trusting an existing generated file. Remote profile bodies are capped at 8 MiB. Failed settings validation/restart restores `sash.json`, the previous generated config and the previous runtime where possible.

Remote Update All performs network fetches with bounded concurrency, deduplicates in-flight requests, then serializes short state commits. Each commit rechecks that the profile still exists and still has the same URL.

The scheduler checks every 15 minutes, with a startup check after 10 seconds. Provider `profile-update-interval` is respected; the default is 24 hours. Per-profile failures are persisted as `lastError` while the previous valid content remains available.

A legacy `sash.json.subscriptionUrl` is migrated once and removed. Corrupt settings or profile indexes are rejected rather than silently replaced.

---

## 5. Core Update Transaction and Download Trust

Release downloads are restricted by `GITHUB_DOWNLOAD_HOSTS`. The initial URL and every redirect target must use HTTP(S) and match the allowlist. The allowlist parameter is mandatory at the download helper type boundary.

Update flow:

1. Download to a unique temporary path.
2. Extract with the 512 MiB uncompressed-size cap.
3. Execute the staged binary with `-v` under a credential-scrubbed environment.
4. Stop the old runtime only after staging succeeds.
5. Rename the old binary to `.bak` and install the staged binary.
6. If the core was running, start it and wait for controller health.
7. Commit `state/install.json`, then delete `.bak`.
8. On failure, stop the candidate, restore binary and install record, and restart the old runtime.

---

## 6. Runtime and Process Safety

- PID termination is fail-closed: identity must match before a signal is sent.
- Core and daemon PID records use `atomicWriteFileSync` and mode `0o600` on POSIX.
- Child environments remove GitHub/npm tokens and npm auth variables.
- Controller and daemon loopback requests use the direct dispatcher and never inherit proxy environment routing.
- Unexpected core exit disables the system proxy.
- Changes requiring restart remove the applied proxy before restart and reconcile it afterward, including `mixed-port` changes.
- Daemon startup clears a leftover OS proxy only when settings do not request it.
