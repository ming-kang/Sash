# Backend Architecture

Sash manages one local Core through one loopback daemon. The [high-level architecture](./architecture-proposal.md) explains the overall design; this document defines its implementation boundaries.

## Ownership

`daemon/entry.ts` acquires the instance lease, initializes `SashStateStore`, restores proxy ownership, terminates verified orphan Core processes, and recovers interrupted binary updates before opening the listener. Missing Core does not prevent management startup.

`daemon/app.ts` assembles the profile, settings, runtime and Windows services. `DaemonGate` in `daemon/context.ts` owns one in-memory mutation queue and shutdown admission. Reads do not wait for this queue. Downloads happen outside it, with deadlines and cancellation; commits reject stale saved-state revisions or runtime changes.

Daemon status exposes `mutationQueue: {active: {purpose, startedAt} | null, queued}`. Operations lasting at least five seconds produce one diagnostic, including synchronous work that delayed the timer. Counters remain accurate across cancellation, errors and shutdown retries.

CLI commands use `runtime-owner.ts` and `daemon-lifecycle.ts` for read-only discovery, management startup and API calls. A live but unverified daemon blocks competing startup and cannot be stopped by an unverified signal. CLI discovery uses the observed daemon port. The private browser handoff and startup diagnostics are the only incidental CLI files.

Daemon startup also holds an installation admission lock while loading application code and publishing its instance record. The per-user installation registry is independent of `SASH_HOME`, so separate data directories using the same package can be discovered together. Records identify the package, Node executable, data directory, PID and boot; cleanup only removes the matching boot. Health and status expose the version captured at startup and the installation ID, which remain stable if package files change afterward.

| Module | Responsibility |
| --- | --- |
| `app-state.ts` | The sole atomic application manifest commit |
| `settings.ts`, `settings-service.ts` | Validate and save preferences; reconcile explicit proxy intent |
| `profile-model.ts`, `profiles.ts`, `profile-service.ts` | Validate metadata/YAML, manage immutable sources and saved selection |
| `runtime-lifecycle.ts` | Order Core and proxy changes; retain the applied configuration and runtime revision |
| `supervisor.ts`, `process.ts` | Owned child handles, version/health checks and verified termination |
| `core.ts`, `core-update.ts`, `core-install-record.ts` | Trusted downloads and one executable/install-record transaction |
| `system-proxy-manager.ts`, `sysproxy/` | Windows proxy snapshot, verification and conditional recovery |
| `autostart.ts`, `autostart/` | Windows current-user registration and launcher validation |
| `daemon/router.ts`, `daemon/handlers/` | Route matching, authentication, parsing and domain dispatch |
| `contracts.ts`, `sash-client.ts`, `daemon-client.ts` | Shared browser-safe protocol and direct Node transport |

Persistent locks remain only where separate processes share a resource: daemon startup/singleton ownership and per-user Windows proxy/autostart operations. There are no runtime, settings or offline mutation locks and no CLI maintenance handoff.

## Saved state

The only supported application manifest is:

```ts
{
  schemaVersion: 2,
  revision: number,
  settings: { mixedPort, controller, secret, allowLan, daemonPort, daemonSecret, systemProxy },
  profiles: { activeId: string | null, profiles: ProfileMeta[] }
}
```

`ProfileMeta` contains an ID, a content revision, a display name, source URL, update interval, timestamps and optional provider/error metadata. Content lives in `profiles/<id>/<revision>.yaml`. Names and paths are separate; clients cannot provide arbitrary file paths.

Remote updates persist `lastAttemptAt` and `failureCount`. Scheduled retries back off from fifteen minutes to one day; manual updates bypass the delay. Success or an editor save clears the failure count. Manual, all-profile and scheduled requests share one in-flight update per profile ID, and cancellation does not count as a provider failure.

Saving source content validates bounded core-format YAML, atomically writes a new immutable file, then atomically commits its reference with the rest of `sash.json`. A crash before the manifest commit leaves the previous source referenced. Deletion commits removal before cleanup. Unreferenced files may remain after interrupted cleanup; they are not a second source of truth. Identical remote bytes retain the content revision. Editor writes must include the revision read when opening the editor; stale writes return a conflict.

The manifest is capped at 2 MiB, profile content at 8 MiB. Readers reject invalid schemas, duplicate IDs, invalid revisions, non-regular files and oversized content. Secrets must be nonblank, the controller must be loopback-only, and all listener ports must differ. No legacy formats or migrations are accepted. Existing invalid state is preserved.

Daemon readers share one deeply frozen snapshot per committed revision. A successful commit invalidates it; failed writes preserve the previous snapshot. Settings PATCH accepts `expectedRevision` and returns the committed `revision`. Stale writes fail with `409` before preference or OS changes. The dashboard supplies its observed revision and ignores older write responses.

`runtime/config.yaml` is derived from the selected saved profile or the built-in DIRECT-only default. Source YAML is preserved verbatim. Sash overlays operational ports, controller credentials and LAN access, removes competing controller sockets/pipes and tunnels, disables TUN and rejects all custom listeners before replacing the runtime configuration.

## Save, Apply and stop

Network preference changes, profile selection, edits and scheduled downloads only save state. They do not restart or reload Core. System-proxy intent is a separate OS action: enable requires a healthy owned Core; disable saves the off preference before attempting restoration and can be retried without another manifest write.

Routing-mode changes affect the running Core only. The controller call runs outside the application mutation queue and verifies Core ownership before and after the request. It does not save a preference or advance the state revision; Apply restores the mode from the selected profile.

Apply executes inside the daemon queue:

1. Generate the candidate from saved state and run Core's configuration validator against a private temporary file.
2. Restore the original system proxy. Failure leaves the current healthy Core running.
3. Stop the verified Core and ensure its controller is vacant.
4. Atomically publish the generated configuration.
5. Start Core, verify the expected version through consecutive readiness probes, and record the applied configuration.
6. Reconcile the saved system-proxy preference against the actual running port.

Validation failure leaves the old runtime untouched. Failure after stopping does not roll back saved edits; management stays available and reports the unapplied configuration. There is no general settings/profile/runtime compensation transaction.

Core stop cancels Core downloads and the configuration-test child while allowing profile downloads to finish. Daemon shutdown also cancels profile downloads, rejects later mutations, drains the active operation, restores proxy state, stops Core, acknowledges with `204`, then closes the listener. Cleanup failure keeps the daemon available for retry. An active binary swap completes or rolls back in order.

Unexpected Core exits trigger bounded proxy-restoration retries. Late child events cannot clear a replacement child. Status and proxy application verify that ownership remained the same across asynchronous probes. Unknown identity or uncertain termination preserves the PID record.

## Core updates

Core acquisition selects an unmodified upstream release artifact using official GitHub metadata. Mirrors transport bytes only. Initial URLs and redirects must be HTTPS and host-allowlisted; the complete archive must match the official SHA-256 digest. Archives are capped at 128 MiB, extraction at 512 MiB, ZIP paths cannot escape, and the staged executable must report the exact requested version.

Extraction also hashes the decompressed executable. New install records and update journals retain this SHA-256; configuration validation and process startup check it before executing Core. Recovery authenticates each binary slot against its journal digest before moving or removing files. Executable probes serve as health checks.

Existing version-only install records remain readable. Before their next Core start or update, Sash obtains the same official release, verifies its archive, and compares the extracted digest with the installed file before adding the digest atomically. Existing interrupted journals receive the same verification before recovery. A failed lookup, cancellation, changed metadata or digest mismatch preserves the existing binary and its ownership records.

App captures the applied configuration when Core is running, or saved configuration when it is stopped. Download and candidate config validation leave management responsive. Before publication the queue rechecks saved-state and runtime revisions.

`core-update.ts` receives only the staged executable and runtime callbacks. Its fixed journal contains previous/target install records and three phases:

| Phase | Meaning |
| --- | --- |
| `prepared` | Rollback ownership is durable before moving files |
| `swapped` | New executable and install metadata are published |
| `verified` | Health verification and restoration of the original running/stopped state succeeded |

The old executable remains `.bak` until the final phase. Even a stopped update or first install performs a temporary start and health check immediately, with no system proxy enabled, then stops again. Failure restores the old binary/install record and, when applicable, the original running state. Recovery preserves unrecognized or corrupt files and blocks another unsafe update. A verified journal only needs final cleanup.

Profile sources, metadata and settings never participate in this transaction. There is no deferred health decision, force-repair quarantine or coordinated second journal.

## Windows integration

System-proxy ownership uses `state/system-proxy.json` with `prepared`, `applied` and `restoring` phases. Before OS writes it stores the original and target Windows registry values. Managed values are proxy enable/server, bypass list and PAC URL; Windows owns `AutoDetect`, which is observed but not written or compared for ownership.

Recovery restores an exact owned target, or original/target-compatible partial values from `prepared`/`restoring`. Third-party changes to an already applied target block restoration. Missing journals never authorize disabling an unrelated proxy. The per-user OS lock is independent of `SASH_HOME` so separate instances cannot write the registry concurrently.

Proxy operations use asynchronous, bounded helper processes. Inspection is cached briefly, shared while in flight, and reports unknown while a local write is pending. Unstable journal observations are retried once and never cached. Desired, Sash-applied and OS-observed proxy state remain separate.

Autostart uses a current-user registry entry and hidden launcher. See [Automatic Startup](./autostart.md). Other platforms report desktop integration as unsupported; portable CLI/Core primitives remain available.

## HTTP contract

`/sash/*` is implemented by the daemon, `/core/api/*` is the authenticated Core gateway, and `/ui/*` serves the bundled dashboard. The route table is the canonical API inventory.

| Endpoint | Method | Access / result |
| --- | --- | --- |
| `/sash/daemon/health` | GET | Public per-boot identity, PID and start time |
| `/sash/daemon/status` | GET | Public management/runtime snapshot; subscription URLs require control authentication |
| `/sash/daemon/shutdown` | POST | Control; complete cleanup, then `204` and listener close |
| `/sash/web/bootstrap` | POST | Control; mint one-time browser handoff |
| `/sash/web/session` | POST | Redeem the handoff token supplied in the body |
| `/sash/core/start` | POST | Control; idempotent start, applying saved state if stopped |
| `/sash/core/restart` | POST | Control; Apply saved state and restart Core |
| `/sash/core/stop` | POST | Control; stop Core, keep management; `204` |
| `/sash/core/update` | POST | Control; optional `{version}`, returns `{version}` |
| `/sash/core/mode` | PUT | Control; `{mode}` changes running Core mode |
| `/sash/proxy` | GET | Public desired/applied/observed state |
| `/sash/settings` | GET / PATCH | Control; read settings or save `{mixedPort?, allowLan?, systemProxy?}` |
| `/sash/autostart` | GET / PUT | Control; inspect or set `{enabled}` |
| `/sash/profiles` | GET / POST | Control; metadata list or remote import |
| `/sash/profiles/import` | POST | Control; local YAML import |
| `/sash/profiles/order` | PUT | Control; save complete `{ids}` order |
| `/sash/profiles/active` | PUT | Control; save `{id}` or `null`, without applying |
| `/sash/profiles/update-all` | POST | Control; saved updates, with per-profile failures |
| `/sash/profiles/:id/content` | GET / PUT | Control; read YAML/revision or save `{content, revision}` |
| `/sash/profiles/:id/update` | POST | Control; download and save new content |
| `/sash/profiles/:id` | PATCH / DELETE | Control; rename or remove |

Status includes `daemon.bootId`, `revisions.state` (saved-state revision), `revisions.runtime`, and `configuration: {pending, appliedProfile, appliedSettings}`. Saved selection and actual running configuration are distinct. Proxy observation flags are required; no absent flag is guessed from an old protocol. Diagnostic Core probes share in-flight work and a 500ms cache bound to the owned Core generation. Safety decisions bypass settled Core observations. On status and proxy routes, `?fresh=1` requires control authentication and bypasses settled probe caches.

Success bodies are resources; empty mutations return `204`. Errors use `{error: {code, message}}`. Unknown required fields or malformed successful payloads are rejected by the shared client. Raw settings editing and config reload routes do not exist.

The Core gateway permits queries, node selection and connection deletion. Managed configuration changes must use Sash controls. Mode uses `/sash/core/mode`; traffic and log WebSockets use `/core/api/traffic` and `/core/api/logs`.

## Security and persistence

The listener binds to `127.0.0.1`, validates loopback Host/Origin, and parses one canonical origin-form target for authentication and forwarding. Core requests use a direct dispatcher. Browser requests carry private per-boot sessions; the persistent CLI bearer never reaches the browser or Core gateway. Public health identity is not a credential. API responses are non-cacheable.

`sash web` creates a 90-second single-use handoff in an owner-private local file. The browser removes its fragment before redemption, stores the session in tab storage and verifies the daemon boot. Only hashes are retained in the daemon, with bounded grant/session counts. Restarting Core preserves sessions; restarting the daemon invalidates them.

All helper children receive scrubbed environments. Sensitive state/logs use POSIX `0600`; browser handoffs also use owner-only Windows ACLs. Atomic publication uses a same-directory temporary file, file fsync, rename and POSIX directory fsync. Windows sharing violations are retried without deleting unverified files. Use a local filesystem supporting atomic rename and hard links.
