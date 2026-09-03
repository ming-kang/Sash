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
- `src/daemon-lifecycle.ts`: daemon discovery, singleton startup, CLI shutdown and the maintenance boundary used by full restarts and Core updates.
- `src/state-lock.ts`: atomic file leases and cross-process mutation queues.
- `src/system-proxy-manager.ts`: durable proxy ownership journal, serialized asynchronous OS operations, generation-bound observation cache and conditional recovery.
- `src/sysproxy.ts` / `src/sysproxy/`: public system-proxy API plus focused Windows, macOS and GNOME asynchronous snapshot/apply backends.
- `src/profile-service.ts`: profile/config preparation and publication through one-shot opaque capabilities with strict optimistic rechecks.
- `src/core-install-record.ts`: the canonical install-record codec and release-tag validation shared by install and update paths.
- `src/core-update.ts`: the low-level executable/install-record transaction, force-repair quarantine and crash recovery.
- `src/core-update-coordination.ts`: one logical commit/rollback decision across retained managed state and the Core update journal.
- `src/core-update-service.ts`: staged update, runtime ownership, maintenance, publication and restoration orchestration.
- `src/offline-mutation.ts` / `src/runtime-recovery.ts`: daemon/offline ownership checks and the fixed legacy-proxy, journaled-proxy, stale-Core and update-recovery order.
- `src/http.ts` / `src/github.ts`: bounded networking and trusted release downloads, including one absolute asset budget shared across mirror attempts and redirects.
- `src/settings.ts`: versioned runtime schema, explicit public-field allowlist and immutable managed-key candidates for `sash.json`.
- `src/settings-service.ts`: shared online/offline settings preparation, durable publication and runtime-transition orchestration.
- `src/contracts.ts`: browser-safe API contracts and `unknown`-to-typed response parsers shared by the daemon client and WebUI.
- `src/json-shape.ts` / `src/error-utils.ts`: domain-neutral JSON shape, canonical timestamp and unknown-error helpers; persistent readers retain their own size, missing and corruption policies.
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

Lock records are fully written and fsynced before an atomic hard-link publishes them. Synchronous and asynchronous callers share one acquisition decision and differ only in how they wait, so live-owner, dead-owner, corruption and deadline rules cannot drift. A live owner is never displaced. Dead owners can be reclaimed; corrupt records fail closed and require explicit repair. If a lock disappears between metadata inspection and bounded content read it is retried as a missing observation rather than mislabeled corrupt. Durable rename/remove operations retry Windows sharing violations without deleting a caller-owned source; an interrupted executable unlock probe is restored before Core consistency checks, while conflicting target/probe bytes are both preserved for explicit repair.

Offline commands reload settings after acquiring `mutation.lock`. Ordinary mutations refuse a live orphan Core or corrupt PID record. Lifecycle and update callers must explicitly request reconciliation, which restores legacy and journaled proxy ownership before terminating only a verified stale Core and then recovering coordinated update state.

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

The Node daemon client and browser WebUI both read successful health, status and proxy bodies as `unknown`, then pass them through the same browser-safe parsers in `src/contracts.ts`. Required nested fields, positive safe-integer PIDs, valid ports, nonnegative revisions, canonical timestamps, optional Core fields, proxy state and explicit public settings are validated before state changes. Unknown extra fields are tolerated for forward compatibility but discarded from the typed projection. `appliedKnown` and `stateKnown` are mandatory inside the current daemon; only the network parser normalizes flags omitted by a legacy daemon to `false`. A malformed `200` response is therefore an error, not trusted TypeScript data.

### `/core/*`

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/core/start` | `POST` | Rebuild config, start and wait for readiness. |
| `/core/stop` | `POST` | Restore proxy, then stop the child. |
| `/core/restart` | `POST` | Rebuild config and execute one serialized replacement. |
| `/core/config/reload` | `POST` | Re-render, validate and reload active config. |

### `/core/api/*`

Every request in this namespace requires the persistent CLI bearer or per-boot WebUI token before an upstream connection is opened. `sashd` strips Sash credentials and the browser Host header, then injects the internal controller bearer.

HTTP and WebSocket routing consume one parsed origin-form request target. Absolute-form, authority-form, asterisk-form, network-path and cross-authority backslash targets are rejected with `400`. Route matching removes only trailing route slashes; WHATWG dot-segment normalization happens once, encoded slashes are not decoded again, and the same canonical pathname constructs the Core target. In particular, `/core/api?x=1` forwards as `/?x=1`, repeated namespace-root slashes collapse to `/`, and the query is appended exactly once.

Known paths with the wrong method return `405` plus `Allow`. Dashboard redirects accept only `GET`/`HEAD` and preserve the root query. Legacy aliases remain explicit rather than coming from generic `/sash` prefix removal: `/health`, `/status`, `/proxy`, `/proxy/enable`, `/proxy/disable`, `/settings`, `/shutdown` and `/config/reload` retain only their documented method-specific mappings.

Traffic/log streams use authenticated `GET` WebSocket upgrades. The WebSocket allowlist is `/core/api/*`, `/traffic` and `/logs`; standard HTTP controller prefixes are not implicitly WebSocket-enabled.

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

`SettingsService` snapshots committed settings, creates an immutable canonical candidate, then fetches/renders/Core-validates active profile configuration outside the mutation lock. Under the short commit boundary it rechecks settings/profile snapshots and journals settings plus generated config before publication. The daemon exposes only `committedSettings` to GET/status/auth handlers; Core spawn/restart can temporarily use `runtimeSettings` while a candidate transition is in progress. The committed in-memory snapshot changes only after the journaled transition succeeds; failure restores disk/config and the old runtime. Online TUN enable is additionally committed only when the restarted Core reports `tun.enable: true`; inactive or unverified results use the same disk/config/runtime compensation path. Inactive TUN errors direct every platform to rerun a full `sash restart` from an elevated shell, which replaces the daemon itself; they preserve the data root explicitly only where it was customized or `sudo` would change the default home. A Core-only restart (for example from the dashboard) cannot elevate `sashd`.

Prepared profile work is never exposed as a mutable internal transaction object. `ProfileService` issues WeakMap-backed, one-shot opaque capabilities that reject forgery, cross-instance use and repeated consumption. Settings publication deliberately binds a weak active-source snapshot (`activeId`, profile identity/URL and exact raw YAML digest), so unrelated metadata updates do not invalidate an otherwise safe settings change. A strict active reload instead binds the committed settings, complete active `ProfileMeta`, active selection and raw digest. Both paths prepare outside the mutation boundary and consume the capability only while rechecking and publishing; only a conflict raised before the publication callback is entered receives the single bounded automatic retry.

Profile application follows:

1. Parse the untrusted source profile.
2. Overlay Sash-owned operational keys.
3. Write an isolated candidate.
4. Run the installed Core with `-t -d <root> -f <candidate>`.
5. Enter the short profile commit boundary, re-read the bounded regular index/profile files and verify the target profile identity, URL, active selection, managed-settings snapshot and exact raw-profile SHA-256 captured during preparation.
6. Snapshot the affected fixed roles (`sash.json`, profile YAML, index and/or `config.yaml`), then atomically persist a `publishing` record in `state/managed-state-transaction.json` before publication.
7. Ordinary settings/profile publication reloads or restarts only after every file is published, marks the journal `committed`, then clears it. The same journal can include the canonical `sash.json` snapshot. Startup finalizes a committed journal without rolling the published state back.
8. Core update publication uses a version-3 `core-update` coordination record. After profile/index/config files publish, phase `retained` preserves their exact pre-update snapshots until the Core journal has a durable health/restoration outcome. Ordinary mutations cannot consume this retained state.
9. On any publication or reload failure, restore every snapshot while continuing after individual restore errors, then reload the prior config when one existed. A rollback reload failure is reported explicitly. Incomplete rollback retains the journal; daemon and offline initialization recover an ordinary `publishing` journal under `mutation.lock` before reading or migrating profile state.

The daemon parses profile request bodies before its mutation boundary. Remote fetch, YAML parsing, rendering and Core validation also occur before that boundary; only recheck, publication and runtime reload are serialized. Offline commands use the same split boundary after reloading settings, verifying daemon/orphan-Core ownership and migrating the legacy setting. Remote and stored profile YAML are capped at 8 MiB; `profiles/index.json` is capped at 2 MiB, and both must be regular files. Profile requests use an absolute deadline and explicit hop-by-hop redirects: HTTPS cannot downgrade to HTTP, restricted literal addresses cannot cross origins, and public origins cannot redirect to literal private/loopback targets. Scheduled network fetches use bounded concurrency; state commits remain serialized and recheck profile identity/URL and active selection before publication. Scheduler timers are retained when daemon cleanup or listener closure fails, and are cleared only after successful shutdown.

---

## 6. System-Proxy Ownership

`settings.systemProxy` stores desired state. `state/system-proxy.json` separately records ownership:

```text
prepared:  original snapshot + intended target persisted before OS writes
applied:   target was written and read back exactly
restoring: restoration began and original/target-compatible partial state remains recoverable
```

All platform capture/apply work runs through asynchronous `execFile` children with the same scrubbed environment, absolute trusted-tool resolution, timeout and output bounds as other managed helpers. Commands remain explicitly sequential: Windows writes PAC/endpoints before `ProxyEnable` and awaits best-effort WinINet refresh; macOS writes data before states and turns unwanted modes off before enabling selected modes; GNOME writes every endpoint before changing `mode`. This keeps the daemon event loop responsive without weakening partial-write ordering.

`SystemProxyManager` serializes inspect, apply and release operations in one in-process queue in addition to the cross-process journal lock. Every mutation invalidates a monotonic observation generation when queued and again when complete. Same-generation inspections share one in-flight capture; ordinary polling can reuse a settled short-lived cache, while a fresh read bypasses only that settled cache. Inspection compares strict journal observations before and after OS capture and retries once if another process changes or removes the journal. Unstable observations are never cached. `/sash/health` does not enter this queue, so it remains responsive while a slow OS inspection is pending.

Enable flow:

1. Capture all fields Sash will modify.
2. Derive the target and persist `prepared` atomically.
3. Re-read the OS state to detect changes during preparation.
4. Apply and verify the target.
5. Mark the journal `applied`.

Release/recovery restores only when every managed value still equals either the original or Sash target. Before multi-field restoration Sash persists the `restoring` phase, so a crash can continue from an original/target-compatible partial state. A third-party value is never overwritten. Failed restoration retains the journal and blocks deliberate Core shutdown.

Platform scope:

- Windows: manual proxy, bypass list and PAC URL are managed; the legacy flat automatic-detection value is observed for status but intentionally neither written nor verified.
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

Update flow downloads and validates outside runtime ownership. Once staging completes, it acquires `state/runtime.lock` before requesting the atomic maintenance shutdown snapshot and keeps that ownership through offline publication and runtime restoration. Under `mutation.lock`, Sash reloads committed settings, performs legacy/journaled proxy cleanup and verified stale-Core cleanup once, recovers earlier update state, prepares the active profile outside the short commit boundary, then rechecks both the profile capability and controller vacancy before publication.

The final mutation first writes a retained managed-state journal for profile/index/config snapshots, then starts `state/core-update-transaction.json`. Normal updates use the version-1 `prepared`, `swapped` and `health-verified` phases. A previously running Core is verified immediately; a stopped Core remains in `swapped` with the old install record and `.bak` until its next managed start proves the target controller version and health. Successful external restoration marks managed state committed before removing the Core rollback slot, so a crash cannot lose both rollback directions. Failure restores managed state before binary/install metadata and still attempts both sides if either rollback reports an error.

Forced repair uses the version-2 `repair-prepared` and `repair-restoring` phases in addition to the normal swap/health phases. Malformed executable and install-metadata entries are moved to fixed `.repair.bak` quarantine paths only after the journal is durable. Partial quarantine and partial restoration are resumable. Missing, extra or unowned quarantine entries fail closed. Daemon startup and offline commands use the same proxy, stale-Core and coordinated-journal recovery order before ordinary consistency checks.

Official digest metadata is mandatory. If the metadata API is unavailable, Sash refuses an unverifiable mirror download instead of falling back to executing unverified bytes.

---

## 8. Persistence Safety

Atomic state writes use a same-directory temporary file, file `fsync`, rename and POSIX parent-directory `fsync`. Sensitive files use mode `0o600` on POSIX. Important files are:

- `sash.json`: versioned desired settings and local secrets.
- `profiles/index.json`, `profiles/<id>.yaml`: profile metadata/content.
- `config.yaml`: runtime config rendered from the active profile or the DIRECT-only default; a qualifying pre-profile file is preserved during its one-time local-profile import.
- `state/sash.pid`, `state/sashd.pid`: discovery records.
- `state/system-proxy.json`: durable proxy ownership transaction.
- `state/managed-state-transaction.json`: recoverable settings/profile/index/config snapshots, including retained Core-update coordination state.
- `state/install.json`: committed Core version metadata using the shared fixed-shape install-record codec.
- `state/core-install-transaction.json`: strict first-install publication journal.
- `state/core-update-transaction.json`: strict version-1 update journal or version-2 force-repair quarantine journal, including deferred managed-start rollback ownership.
- `state/*.lock`: local-filesystem ownership records.

`SASH_HOME` should reside on a local filesystem that supports atomic rename, hard links and normal per-user permissions.
