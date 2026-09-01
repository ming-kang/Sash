# Backend Architecture & Supervisor Design

Sash uses a loopback-only supervisor daemon (`sashd`) to own the Core process, generated configuration, profile state, system-proxy ownership and the HTTP/WebSocket gateway.

```text
CLI / WebUI
    │  http://127.0.0.1:19090
    ▼
sashd
├── /sash/*       settings, profiles, status, system proxy
├── /core/*       serialized Core lifecycle and config reload
├── /core/api/*   authenticated controller reverse proxy
├── ProfileService
├── RuntimeLifecycle
│   ├── CoreSupervisor
│   └── SystemProxyManager
└── state locks / atomic persistence
```

The Core remains a non-detached child of `sashd`. Runtime transitions, disk mutations and daemon startup are serialized at separate boundaries instead of relying on PID files as locks.

---

## 1. Module Boundaries

- `src/daemon.ts`: daemon assembly, routing, scheduler and shutdown.
- `src/runtime-lifecycle.ts`: serialized Core/proxy state transitions.
- `src/supervisor.ts`: child ownership, readiness probes and verified termination.
- `src/daemon-lifecycle.ts`: daemon discovery, singleton startup and CLI shutdown.
- `src/state-lock.ts`: atomic file leases and cross-process mutation queues.
- `src/system-proxy-manager.ts`: durable proxy ownership journal and conditional recovery.
- `src/sysproxy.ts`: Windows, macOS and GNOME snapshot/apply backends.
- `src/profile-service.ts`: profile/config application transactions.
- `src/core-update.ts`: executable/install-record update transaction and crash recovery.
- `src/http.ts` / `src/github.ts`: bounded networking and trusted release downloads.
- `src/settings.ts`: versioned runtime schema for `sash.json`.
- `src/contracts.ts`: API contracts shared by the daemon client and WebUI.

---

## 2. Ownership and Serialization

### Daemon ownership

`sashd` acquires `state/sashd.lock` before reading or migrating persistent state. The lock record contains a random token, PID, purpose and timestamp. A PID file is discovery metadata only; it is never the singleton authority.

- `state/sashd-start.lock` serializes concurrent CLI spawn attempts.
- `state/runtime.lock` serializes top-level `start`, `stop`, `restart` and Core update operations.
- `state/mutation.lock` separates daemon-owned mutations from offline CLI mutations.
- `state/settings.lock` prevents concurrent first-run secret generation and settings rewrites.
- `state/system-proxy.json.lock` serializes proxy journal operations.

Lock records are fully written and fsynced before an atomic hard-link publishes them. A live owner is never displaced. Dead owners can be reclaimed; corrupt records fail closed and require explicit repair.

Offline commands reload settings after acquiring `mutation.lock`. They refuse to write when a daemon lease, live orphan Core PID or corrupt Core PID record makes ownership uncertain.

### Runtime lifecycle

`RuntimeLifecycle` is the only daemon layer that combines Core and system-proxy transitions. Operations enter one promise queue and update a small phase model (`stopped`, `starting`, `running`, `stopping`, `restarting`, `failed`) with a monotonic generation.

Invariants:

1. A start prepares and Core-validates the exact active config before spawn.
2. The Core must pass two readiness probes before it is considered healthy.
3. Desired system proxy is applied only after readiness.
4. A deliberate stop restores the previous OS proxy before stopping the Core.
5. If proxy restoration cannot be proved, the healthy Core is left running.
6. Late child-exit events and delayed cleanup callbacks cannot clear a replacement child.
7. Failed termination preserves PID ownership instead of pretending the process stopped.

Unexpected Core exit retries proxy restoration and records failures in daemon error logs.

---

## 3. API Namespaces

### `/sash/*`

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/sash/health` | `GET` | Readiness, PID, start time and per-boot WebUI token. |
| `/sash/status` | `GET` | Daemon/Core/proxy/public-settings snapshot. |
| `/sash/proxy` | `GET` | Desired, Sash-owned and observed OS proxy state. |
| `/sash/proxy/enable` | `POST` | Persist and apply proxy ownership; requires a healthy Core. |
| `/sash/proxy/disable` | `POST` | Persist off and restore the pre-Sash proxy snapshot. |
| `/sash/profiles*` | mixed | List, add/import, activate, update and delete profiles. |
| `/sash/settings` | `GET` / `PATCH` | Read or transactionally update managed settings. |
| `/sash/shutdown` | `POST` | Restore proxy, stop Core and close `sashd`. |

Appending `?fresh=1` to status/proxy reads bypasses the short OS-state cache used by normal WebUI polling.

### `/core/*`

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/core/start` | `POST` | Rebuild config, start and wait for readiness. |
| `/core/stop` | `POST` | Restore proxy, then stop the child. |
| `/core/restart` | `POST` | Rebuild config and execute one serialized replacement. |
| `/core/config/reload` | `POST` | Re-render, validate and reload active config. |

### `/core/api/*`

Requests are forwarded to the internal controller. `sashd` strips Sash credentials and the browser Host header, then injects the internal controller bearer. Traffic/log streams use authenticated WebSocket upgrades.

---

## 4. Control-Request Security

- The listener binds only to `127.0.0.1` and rejects non-loopback Host headers.
- State-changing methods require the persistent CLI bearer or per-boot WebUI token.
- WebSocket upgrades additionally validate loopback Origin and route boundaries.
- Public settings/status contracts omit controller and daemon secrets.
- Controller and daemon clients use a direct dispatcher; proxy environment variables apply only to remote downloads.
- Child environments remove GitHub/npm tokens and npm authentication variables.

---

## 5. Settings, Profiles and Config Transactions

`sash.json` has explicit `schemaVersion: 1`. Loading validates the JSON root, every field type, port range, controller address and unknown keys. Version-0 files and removed version metadata migrate to canonical v1. Invalid or future-version files are never overwritten.

Profile application follows:

1. Parse the untrusted source profile.
2. Overlay Sash-owned operational keys.
3. Write an isolated candidate.
4. Run the installed Core with `-t -d <root> -f <candidate>`.
5. Snapshot affected config/profile/index state.
6. Atomically publish `config.yaml`.
7. Reload or restart the runtime.
8. Commit metadata only after runtime success; otherwise restore the snapshot.

Remote bodies are capped at 8 MiB. Scheduled network fetches use bounded concurrency; state commits remain serialized and recheck profile identity/URL before publication.

---

## 6. System-Proxy Ownership

`settings.systemProxy` stores desired state. `state/system-proxy.json` separately records ownership:

```text
prepared: original snapshot + intended target persisted before OS writes
applied:  target was written and read back exactly
```

Enable flow:

1. Capture all fields Sash will modify.
2. Derive the target and persist `prepared` atomically.
3. Re-read the OS state to detect changes during preparation.
4. Apply and verify the target.
5. Mark the journal `applied`.

Release/recovery restores only when every managed value still equals either the original or Sash target. A third-party value is never overwritten. Failed or partial restoration retains the journal and blocks deliberate Core shutdown.

Platform scope:

- Windows: manual proxy, bypass list, PAC URL and automatic detection registry values.
- macOS: HTTP, HTTPS, SOCKS and automatic proxy URL/state for every active network service. Existing authenticated proxy settings are not taken over because credentials cannot be restored safely.
- Linux: GNOME `gsettings` mode, automatic URL, HTTP authentication toggle and HTTP/HTTPS/SOCKS endpoints. Other desktop environments are reported unsupported.

A missing journal never authorizes Sash to disable an unrelated system proxy.

---

## 7. Core Download and Update Trust

Release identity and asset metadata come only from official GitHub endpoints. Asset mirrors are byte transports, not trust roots.

- Release tags are restricted to safe path tokens.
- Every initial/redirect URL is HTTPS and host-allowlisted.
- Downloads are streamed with a 128 MiB archive cap and backpressure.
- The complete archive must match the SHA-256 digest published in GitHub release metadata.
- Extraction has a 512 MiB output cap; ZIP deflate is streamed rather than fully inflated in memory.
- The staged executable must report the exact requested release token via `-v`.
- The staged executable validates the freshly generated active configuration before publication.

Update flow stops `sashd`, restores proxy ownership, reconciles stale Core/update state, swaps the executable, verifies a previously running runtime, commits `state/install.json`, then restores the daemon/runtime. The rollback slot is deleted only after that external runtime restoration succeeds; otherwise it is retained. `current + .bak` crash states are resolved by matching binaries against strictly validated version metadata; ambiguous states fail closed without deleting either file.

Official digest metadata is mandatory. If the metadata API is unavailable, Sash refuses an unverifiable mirror download instead of falling back to executing unverified bytes.

---

## 8. Persistence Safety

Atomic state writes use a same-directory temporary file, `fsync` and rename. Sensitive files use mode `0o600` on POSIX. Important files are:

- `sash.json`: versioned desired settings and local secrets.
- `profiles/index.json`, `profiles/<id>.yaml`: profile metadata/content.
- `config.yaml`: generated runtime config.
- `state/sash.pid`, `state/sashd.pid`: discovery records.
- `state/system-proxy.json`: durable proxy ownership transaction.
- `state/install.json`: committed Core version metadata.
- `state/*.lock`: local-filesystem ownership records.

`SASH_HOME` should reside on a local filesystem that supports atomic rename, hard links and normal per-user permissions.
