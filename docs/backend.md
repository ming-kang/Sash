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
- `src/sysproxy.ts` / `src/sysproxy/`: public system-proxy API plus focused Windows, macOS and GNOME snapshot/apply backends.
- `src/profile-service.ts`: profile/config application transactions.
- `src/core-update.ts`: executable/install-record update transaction and crash recovery.
- `src/http.ts` / `src/github.ts`: bounded networking and trusted release downloads, including one absolute asset budget shared across mirror attempts and redirects.
- `src/settings.ts`: versioned runtime schema and immutable managed-key candidates for `sash.json`.
- `src/settings-service.ts`: shared online/offline settings preparation, durable publication and runtime-transition orchestration.
- `src/contracts.ts`: API contracts shared by the daemon client and WebUI.
- `src/status.ts`: stable CLI status/proxy observations, explicit unknown values and complete/incomplete exit semantics.
- `src/log-follow.ts`: bounded tail/follow cursors with creation, truncation, identity-rotation and cancellation handling.

---

## 2. Ownership and Serialization

### Daemon ownership

`sashd` acquires `state/sashd.lock` before reading or migrating persistent state. The lock record contains a random token, PID, purpose and timestamp. A PID file is discovery metadata only; it is never the singleton authority.

- `state/sashd-start.lock` serializes concurrent CLI spawn attempts.
- `state/runtime.lock` serializes top-level `start`, `stop`, `restart` and Core update operations.
- `state/mutation.lock` separates daemon-owned mutations from offline CLI mutations.
- `state/settings.lock` prevents concurrent first-run secret generation and settings rewrites.
- `state/system-proxy.json.lock` serializes proxy journal operations.

Lock records are fully written and fsynced before an atomic hard-link publishes them. A live owner is never displaced. Dead owners can be reclaimed; corrupt records fail closed and require explicit repair. Durable rename/remove operations retry Windows sharing violations without deleting a caller-owned source; an interrupted executable unlock probe is restored before Core consistency checks, while conflicting target/probe bytes are both preserved for explicit repair.

Offline commands reload settings after acquiring `mutation.lock`. They refuse to write when a daemon lease, live orphan Core PID or corrupt Core PID record makes ownership uncertain.

### Runtime lifecycle

`RuntimeLifecycle` is the only daemon layer that combines Core and system-proxy transitions. Operations enter one promise queue and update a small phase model (`stopped`, `starting`, `running`, `stopping`, `restarting`, `failed`) with a monotonic generation.

Invariants:

1. A start prepares and Core-validates the exact active config before spawn.
2. The Core must pass two readiness probes before it is considered healthy.
3. After readiness, a bounded `/configs` probe records the actual `tun.enable` state; probe failure is represented as unknown instead of being mistaken for inactive.
4. Desired system proxy is applied only after readiness.
5. A deliberate stop restores the previous OS proxy before stopping the Core.
6. If proxy restoration cannot be proved, the healthy Core is left running.
7. Late child-exit events and delayed cleanup callbacks cannot clear a replacement child.
8. Controller status probes retain an owned-child generation snapshot and report stopped if that child exits or is replaced while the probe is pending.
9. System-proxy application verifies the same healthy owned child before and after OS changes; lost ownership immediately triggers proxy release.
10. Process ownership is revalidated before every graceful or force signal; failed verification or termination preserves PID ownership.

Unexpected Core exit retries proxy restoration and records failures in daemon error logs.

---

## 3. API Namespaces

### `/sash/*`

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/sash/health` | `GET` | Readiness, PID, start time and per-boot WebUI token. |
| `/sash/status` | `GET` | Daemon/Core/proxy/public-settings snapshot; `core.tunActive` is the verified runtime TUN state when available, while proxy `appliedKnown`/`stateKnown` and `queryError` preserve OS observation uncertainty. |
| `/sash/proxy` | `GET` | Desired, Sash-owned and observed OS proxy state. |
| `/sash/proxy/enable` | `POST` | Persist and apply proxy ownership; requires a healthy Core. |
| `/sash/proxy/disable` | `POST` | Persist off and restore the pre-Sash proxy snapshot. |
| `/sash/profiles*` | mixed | List, add/import, activate, update and delete profiles. |
| `/sash/settings` | `GET` / `PATCH` | Read or transactionally update managed settings. |
| `/sash/shutdown` | `POST` | Restore proxy and stop Core before returning success; the listener closes only after that response finishes. Cleanup failure returns `500` and leaves the daemon available for retry. |
| `/sash/maintenance/shutdown` | `POST` | Under the daemon mutation queue, snapshot whether Core was running, restore proxy/stop Core, return `{ok, coreWasRunning}`, then close. The closing gate rejects mutations admitted after the snapshot. |

Appending `?fresh=1` to status/proxy reads bypasses the short OS-state cache used by normal WebUI polling.

### `/core/*`

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/core/start` | `POST` | Rebuild config, start and wait for readiness. |
| `/core/stop` | `POST` | Restore proxy, then stop the child. |
| `/core/restart` | `POST` | Rebuild config and execute one serialized replacement. |
| `/core/config/reload` | `POST` | Re-render, validate and reload active config. |

### `/core/api/*`

Every request in this namespace requires the persistent CLI bearer or per-boot WebUI token before an upstream connection is opened. `sashd` strips Sash credentials and the browser Host header, then injects the internal controller bearer. Traffic/log streams use authenticated WebSocket upgrades.

---

## 4. Control-Request Security

- The daemon listener binds only to `127.0.0.1`, rejects non-loopback Host headers, and only accepts loopback Core controller addresses.
- State-changing methods and every HTTP Core-gateway route require the persistent CLI bearer or per-boot WebUI token. Browser mutations additionally require a loopback Origin when the header is present.
- WebSocket upgrades validate loopback Origin, authentication and route boundaries.
- Public settings/status contracts omit controller and daemon secrets.
- Controller and daemon clients use a direct dispatcher with normal TLS verification; proxy environment variables apply only to remote downloads.
- Every managed runtime and OS/browser/package helper child removes GitHub/npm tokens, npm credential-file/auth variables and npm registry credentials. Fixed Windows/macOS system tools use trusted absolute paths; Linux desktop helpers are resolved only through absolute PATH entries.

---

## 5. Settings, Profiles and Config Transactions

`sash.json` has explicit `schemaVersion: 1`. Loading validates the JSON root, every field type, nonblank control-character-free secrets, port range, loopback controller address, unknown keys and all three listener ports (`mixedPort`, controller and daemon) for collisions. Version-0 files and removed version metadata migrate to canonical v1. Invalid or future-version files are never overwritten.

After managed-state recovery, daemon and offline initialization first migrate a nonblank legacy `subscriptionUrl` into an active meta-only profile. That URL has priority over any pre-profile `config.yaml`. Only when `profiles/index.json` does not exist may Sash import `config.yaml` once as the active local `Imported config` profile. A present empty index is an explicit opt-out. The candidate must be bounded, regular, valid core-format YAML and contain non-default routing content after managed operational keys are stripped: nonempty proxies/providers, or nonempty rules/groups that differ from the Sash DIRECT-only default. Exact generated defaults are not imported. Invalid candidates fail initialization without changing `config.yaml`; successful import journals the profile YAML and index under `mutation.lock` while leaving `config.yaml` byte-for-byte in place. Later `ProfileService` preparation re-renders and, when Core is installed, validates the canonical profile-derived candidate before runtime use.

`SettingsService` snapshots committed settings, creates an immutable canonical candidate, then fetches/renders/Core-validates active profile configuration outside the mutation lock. Under the short commit boundary it rechecks settings/profile snapshots and journals settings plus generated config before publication. The daemon exposes only `committedSettings` to GET/status/auth handlers; Core spawn/restart can temporarily use `runtimeSettings` while a candidate transition is in progress. The committed in-memory snapshot changes only after the journaled transition succeeds; failure restores disk/config and the old runtime. Online TUN enable is additionally committed only when the restarted Core reports `tun.enable: true`; inactive or unverified results use the same disk/config/runtime compensation path. Inactive TUN errors direct every platform to stop the unprivileged daemon and start the whole Sash runtime with elevated privileges; they preserve the data root explicitly only where it was customized or `sudo` would change the default home. Restarting only the Core cannot elevate `sashd`.

Profile application follows:

1. Parse the untrusted source profile.
2. Overlay Sash-owned operational keys.
3. Write an isolated candidate.
4. Run the installed Core with `-t -d <root> -f <candidate>`.
5. Enter the short profile commit boundary, re-read the bounded regular index/profile files and verify the target profile identity, URL, active selection, managed-settings snapshot and exact raw-profile SHA-256 captured during preparation.
6. Snapshot the affected fixed roles (`sash.json`, profile YAML, index and/or `config.yaml`), then atomically persist a `publishing` record in `state/managed-state-transaction.json` before publication.
7. Reload or restart the runtime only after every file is published, mark the journal `committed`, then clear it. The same journal can include the canonical `sash.json` snapshot for settings/config publication. Startup finalizes a committed journal without rolling the published state back.
8. On any publication or reload failure, restore every snapshot (continuing after individual restore errors), then reload the prior config when one existed. A rollback reload failure is reported explicitly. Incomplete rollback retains the journal; daemon and offline initialization recover a `publishing` journal under `mutation.lock` before reading or migrating profile state.

The daemon parses profile request bodies before its mutation boundary. Remote fetch, YAML parsing, rendering and Core validation also occur before that boundary; only recheck, publication and runtime reload are serialized. Offline commands use the same split boundary after reloading settings, verifying daemon/orphan-Core ownership and migrating the legacy setting. Remote and stored profile YAML are capped at 8 MiB; `profiles/index.json` is capped at 2 MiB, and both must be regular files. Profile requests use an absolute deadline and explicit hop-by-hop redirects: HTTPS cannot downgrade to HTTP, restricted literal addresses cannot cross origins, and public origins cannot redirect to literal private/loopback targets. Scheduled network fetches use bounded concurrency; state commits remain serialized and recheck profile identity/URL and active selection before publication. Scheduler timers are retained when daemon cleanup or listener closure fails, and are cleared only after successful shutdown.

---

## 6. System-Proxy Ownership

`settings.systemProxy` stores desired state. `state/system-proxy.json` separately records ownership:

```text
prepared:  original snapshot + intended target persisted before OS writes
applied:   target was written and read back exactly
restoring: restoration began and original/target-compatible partial state remains recoverable
```

Enable flow:

1. Capture all fields Sash will modify.
2. Derive the target and persist `prepared` atomically.
3. Re-read the OS state to detect changes during preparation.
4. Apply and verify the target.
5. Mark the journal `applied`.

Release/recovery restores only when every managed value still equals either the original or Sash target. Before multi-field restoration Sash persists the `restoring` phase, so a crash can continue from an original/target-compatible partial state. A third-party value is never overwritten. Failed restoration retains the journal and blocks deliberate Core shutdown.

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

First install publishes through `state/core-install-transaction.json`: after staging has passed digest/version checks, Sash records an empty pre-install binary/metadata snapshot, publishes the executable, publishes `state/install.json`, marks the transaction `committed`, then clears it. Startup/offline recovery removes binary and metadata for an interrupted `publishing` transaction, while a `committed` marker is only cleared. Transaction JSON uses a strict fixed schema with no stored paths.

Update flow downloads outside runtime ownership, asks `sashd` for the atomic maintenance shutdown snapshot without first reading status, waits for daemon exit, then takes `state/runtime.lock` for the offline executable transaction and runtime restoration. Before any swap, `state/core-update-transaction.json` records strict fixed-path previous/target install records and advances through `prepared`, `swapped` and `health-verified`. A previously running Core is verified immediately; a stopped Core remains in `swapped` with the old install record and `.bak` until its next managed start proves the target controller version/health. Startup then commits the target record and removes the rollback slot, or restores the previous binary/record and attempts to restart it after a failed candidate start. A health-verified update still retains its journal and rollback slot until the original daemon/Core state is restored. Every crash phase is recovered before ordinary consistency checks; malformed journals, missing rollback files and ambiguous binary/record states fail closed and are never executed.

Official digest metadata is mandatory. If the metadata API is unavailable, Sash refuses an unverifiable mirror download instead of falling back to executing unverified bytes.

---

## 8. Persistence Safety

Atomic state writes use a same-directory temporary file, file `fsync`, rename and POSIX parent-directory `fsync`. Sensitive files use mode `0o600` on POSIX. Important files are:

- `sash.json`: versioned desired settings and local secrets.
- `profiles/index.json`, `profiles/<id>.yaml`: profile metadata/content.
- `config.yaml`: runtime config rendered from the active profile or the DIRECT-only default; a qualifying pre-profile file is preserved during its one-time local-profile import.
- `state/sash.pid`, `state/sashd.pid`: discovery records.
- `state/system-proxy.json`: durable proxy ownership transaction.
- `state/managed-state-transaction.json`: recoverable settings/profile/index/config publication snapshots.
- `state/install.json`: committed Core version metadata.
- `state/core-install-transaction.json`: strict first-install publication journal.
- `state/*.lock`: local-filesystem ownership records.

`SASH_HOME` should reside on a local filesystem that supports atomic rename, hard links and normal per-user permissions.
