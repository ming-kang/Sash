# Backend Architecture & Supervisor Design

Sash is structured around a centralized supervisor daemon architecture (`sashd`) that manages the underlying network core, exposes a unified HTTP/WebSocket gateway, and coordinates OS-level system proxy state.

```
                       ┌──────────────────────────────────────────────┐
                       │  Client Layer (WebUI Browser / CLI Commands) │
                       └──────────────────────┬───────────────────────┘
                                              │ HTTP / WebSocket (127.0.0.1:19090)
                                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ Sash Daemon (sashd) — PID Supervisor & API Gateway                                      │
│                                                                                         │
│  ┌────────────────────────┐  ┌─────────────────────────┐  ┌──────────────────────────┐  │
│  │   /sash/* API          │  │   /core/* Lifecycle     │  │   /core/api/* Proxy      │  │
│  │   (Proxy, Sub, Config) │  │   (Start, Stop, Reload) │  │   (Reverse Proxy + Auth) │  │
│  └───────────┬────────────┘  └───────────┬─────────────┘  └────────────┬─────────────┘  │
│              │                           │                             │                │
│              │ (OS Adapters)             │ (ChildProcess handle)       │ (HTTP / WS)    │
│              ▼                           ▼                             ▼                │
│  ┌───────────────────────┐   ┌────────────────────────────────────────────────────────┐ │
│  │ OS System Proxy       │   │ Mihomo Core Process (Child Process, Not Detached)      │ │
│  │ (WinINet/reg,         │   │   - Inbound: 127.0.0.1:17890 (Mixed HTTP/SOCKS5)       │ │
│  │  networksetup,        │   │   - Controller: 127.0.0.1:9090 (External Controller)   │ │
│  │  gsettings)           │   └────────────────────────────────────────────────────────┘ │
│  └───────────────────────┘                                                              │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Supervisor Model (`sashd`)

In Sash's supervisor architecture:
- **`sashd` is the root background service**: Launched detached by the CLI via `src/daemon-lifecycle.ts`.
- **The network core is a managed direct child**: `sashd` (`src/supervisor.ts`) spawns the core binary as a non-detached child process (`spawn`), holding an active child handle and listening to `exit` and `error` streams.
- **Unified Gateway Port (`19090`)**: `sashd` binds to `127.0.0.1:19090`, serving both the static WebUI assets and all API/WebSocket endpoints.

---

## 2. API Design & Namespaces

`sashd` provides three orthogonal namespaces:

### 2.1 `/sash/*` — Supervisor Domain

Endpoints controlling daemon-level capabilities:

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/sash/health` | `GET` | Readiness probe returning daemon PID, boot token, and start timestamp. |
| `/sash/status` | `GET` | Runtime snapshot containing daemon status, core status, proxy states, and settings. |
| `/sash/proxy` | `GET` | Inspect desired, applied, and OS-reported proxy configurations. |
| `/sash/proxy/enable` | `POST` | Enable system proxy (verifies core is running, updates settings, applies OS adapter). |
| `/sash/proxy/disable` | `POST` | Disable system proxy and update persistent settings. |
| `/sash/subscription` | `GET` | Retrieve configured remote subscription URL. |
| `/sash/subscription` | `POST` | Import new subscription, validate YAML, compile `config.yaml`, and hot-reload core. |
| `/sash/subscription` | `DELETE` | Remove subscription and revert to DIRECT-only default configuration. |
| `/sash/subscription/refresh` | `POST` | Refetch subscription and hot-reload running core. |
| `/sash/settings` | `GET` | Retrieve current `sash.json` configuration. |
| `/sash/settings` | `PATCH` | Dynamically update managed keys (handles auto-restarting or hot-reloading). |
| `/sash/shutdown` | `POST` | Gracefully disable system proxy, stop core, and terminate daemon. |

### 2.2 `/core/*` — Core Lifecycle Domain

Endpoints managing the child core process:

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/core/start` | `POST` | Spawns the child core process and polls `/version` until healthy. |
| `/core/stop` | `POST` | Disables system proxy and gracefully terminates the core process. |
| `/core/restart` | `POST` | Restarts the core child process and re-attaches system proxy. |
| `/core/config/reload` | `POST` | Recompiles `config.yaml` and signals the core's controller to reload. |

### 2.3 `/core/api/*` — Upstream Controller Reverse Proxy

- **HTTP Proxying** (`src/daemon-proxy.ts`): Forwards requests directly to the core's external-controller.
- **Server-Side Secret Injection**: Automatically injects the controller's `Authorization: Bearer <secret>` header.
- **WebSocket Streaming**: Transparently handles WebSocket protocol upgrades (`HTTP 101`) for streams such as `/core/api/traffic` and `/core/api/logs`.

---

## 3. System Proxy Adaptation & Fail-Safe Isolation

Sash supports native, user-level system proxy toggling across all three major desktop operating systems (`src/sysproxy.ts`):

- **Windows (`win32`)**: Modifies `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` (`ProxyEnable`, `ProxyServer`, `ProxyOverride`) via `reg.exe` and broadcasts changes to active processes via WinINet `InternetSetOption` using PowerShell. Requires no administrative elevation.
- **macOS (`darwin`)**: Discovers active network services via `networksetup -listallnetworkservices` and configures HTTP, HTTPS, and SOCKS proxies across all active interfaces.
- **Linux (`linux`)**: Uses GNOME desktop `gsettings` (`org.gnome.system.proxy`) in desktop environments.

### Crash Recovery & Self-Healing
1. **Core Unexpected Crash**: `sashd` hooks into `child.on('exit')`. If the core terminates unexpectedly, `sashd` immediately invokes `removeProxyIfApplied()` to clear OS proxy settings and prevent network blackouts.
2. **Daemon Crash Recovery**: On reboot, `sashd` inspects OS proxy state. If the proxy was left enabled from a previous abnormal shutdown, it automatically disables it.
3. **Offline CLI Fallback**: `sash proxy off` directly dispatches to the platform adapter, allowing system proxy removal even when the daemon is completely stopped.

---

## 4. Process Safety & Verification

Sash enforces strict safety invariants:

- **Never kill an unverified PID**:
  - **For Core Binaries (`src/process.ts`)**: Verifies executable path and image name (`/proc/<pid>/exe` on Linux, `Get-Process Path` and `tasklist` on Windows, `ps -o comm=` on macOS) before sending termination signals.
  - **For Daemon Process (`src/daemon-lifecycle.ts`)**: Verifies command line arguments contain `daemon-entry` before sending signals to Node processes.
- **Loopback Traffic Purity**: External-controller requests and daemon communications use dedicated direct dispatchers (`direct: true` in `src/http.ts`), ensuring loopback calls never traverse environment proxies (`HTTP_PROXY`, `ALL_PROXY`).
- **Credential Hygiene**: Child processes are spawned with sanitized environments (`buildSanitizedEnv()`), removing `GITHUB_TOKEN`, `NPM_TOKEN`, and npm authorization secrets. State and log files are written with POSIX `0o600` permissions.
- **Atomic State Changes**: All state modifications (`sash.json`, `config.yaml`, PID records) use `atomicWriteFileSync` in `src/fs-atomic.ts` (write to temporary sibling file followed by atomic rename).
