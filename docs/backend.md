# Backend Architecture

Sash manages one local Core through one loopback daemon. The [high-level architecture](./architecture-proposal.md) explains the overall design; this document defines its implementation boundaries.

## Ownership

`daemon/entry.ts` acquires the data-directory singleton lease, initializes `SashStateStore`, restores proxy ownership, terminates verified orphan Core processes, and recovers interrupted binary updates before opening the listener. Missing Core does not prevent management startup.

`daemon/app.ts` assembles the profile, settings, runtime and Windows services. `DaemonGate` in `daemon/context.ts` owns one in-memory mutation queue and shutdown admission. Reads do not wait for this queue. Downloads happen outside it, with deadlines and cancellation; commits reject stale saved-state revisions or runtime changes.

Operations lasting at least five seconds produce one slow-mutation diagnostic, including synchronous work that delayed the timer. Counters remain accurate across cancellation, errors and shutdown retries.

CLI commands use `runtime-owner.ts` and `daemon-lifecycle.ts` for read-only discovery, management startup and API calls. A live but unverified daemon blocks competing startup and cannot be stopped by an unverified signal. CLI discovery uses the observed daemon port. `sash upgrade` resolves an npm target and runs one global install; it replaces no package files itself, and application state stays daemon-written.

`doctor.ts` composes read-only installation, package-asset, manifest, Core-file and runtime observations. It does not hash installed executables. Invalid state does not suppress independent installation/Core checks. Port checks skip listeners already owned by the observed runtime and report occupied or unavailable stopped ports; diagnostics do not start or repair an instance.

Daemon startup holds the `state/sashd.lock` singleton lease while loading application code and publishing `state/sashd.pid`; `state/sashd-start.lock` serializes competing CLI starts. Health and status expose the version captured at startup and the installation ID, which remain stable if package files change afterward.

| Module | Responsibility |
| --- | --- |
| `app-state.ts` | The sole atomic application manifest commit |
| `settings.ts`, `settings-service.ts` | Validate and save preferences; reconcile explicit proxy intent |
| `profile-model.ts`, `profiles.ts`, `profile-service.ts` | Validate metadata/YAML, manage immutable sources and saved selection |
| `core-yaml.ts`, `profile-source-cache.ts`, `profile-cleanup.ts` | One shared YAML entry point, bounded parsed-source reuse and orphan maintenance |
| `runtime-lifecycle.ts` | Order Core and proxy changes; retain the applied configuration and runtime revision |
| `supervisor.ts`, `process.ts` | Owned child handles, version/health checks and verified termination |
| `core.ts`, `core-archive.ts`, `core-update.ts`, `core-install-record.ts` | Trusted downloads, bounded extraction and one executable/install-record transaction |
| `installation.ts`, `self-upgrade.ts`, `commands/upgrade.ts` | Read-only installation detection, npm target resolution and one global install around a daemon restart |
| `system-proxy-manager.ts`, `sysproxy/` | Windows proxy snapshot, verification and conditional recovery |
| `autostart.ts`, `autostart/` | Windows current-user registration and launcher validation |
| `daemon/router.ts`, `daemon/handlers/` | Route matching, authentication, parsing and domain dispatch |
| `daemon/events.ts`, `daemon/event-observations.ts` | Shared status observer, bounded SSE delivery and cached desktop observations |
| `contracts.ts`, `sash-client.ts`, `daemon-client.ts` | Shared browser-safe protocol and direct Node transport |
| `core-delay.ts`, `status-delay.ts` | Explicit outbound observations and independent CLI sampling |

Persistent locks cover resources shared by processes: daemon singleton/startup ownership and per-user Windows proxy/autostart operations. `state-lock.ts` records pid, token and purpose in a `<name>.lock` file beside the resource it guards; a lock whose owner is no longer running, or whose record has stayed unreadable for 250 ms, is reclaimed instead of blocking forever. `state/sashd.lock` is the daemon singleton lease. Application mutations use the daemon's in-memory queue.

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

Subscription and local-source YAML is parsed once with a plain `YAML.parse`; there is no alias cap and no share-link detection. Only a non-array object is accepted, and the Core's own pre-flight check remains the authority on whether the content is a usable configuration. Empty subscription quota values are not interpreted as zero.

The Core fetches its geodata databases (`geoip.metadb`, `geosite.dat`, `country.mmdb`, `GeoLite2-ASN.mmdb`) while that pre-flight check loads the configuration, and it fetches them itself, ignoring `HTTP_PROXY`. On a network without direct `github.com` access the check therefore fails or stalls, which would deadlock a first start: no Core, because geodata is missing; no geodata, because the Core has not started and cannot serve as the proxy. When the pre-flight check fails and the output shows a geodata download rather than a configuration error, the daemon retries once with `geox-url` rewritten to the same mirror hosts used for Core downloads, and the retried configuration is the one it applies and installs, so the databases are fetched and the data directory keeps a working source. A failure after the retry is reported as `Core could not download its geodata databases`, distinct from a real configuration rejection.

The daemon shares a frozen parsed-source LRU across profile actions and Apply: at most eight entries and 16 MiB of source text. File identity, size and nanosecond modification/change timestamps are rechecked on every read; replacement, removal and non-regular paths cannot reuse a cached source. Rendering does not mutate cached documents.

After scheduled updates, a non-overlapping maintenance tick enters the mutation queue, verifies the manifest is current, and prunes only recognized generated files older than 24 hours. Current profile references, unknown names, recent files and links remain intact; directories are removed only when old and empty. Paths must resolve inside the data directory. Cleanup does not recurse through arbitrary directories and skips temporary Core files during download.

Daemon readers share one deeply frozen snapshot per committed revision. A successful commit invalidates it; failed writes preserve the previous snapshot. Settings PATCH accepts `expectedRevision` and returns the committed `revision`. Stale writes fail with `409` before preference or OS changes. The dashboard supplies its observed revision and ignores older write responses.

`runtime/config.yaml` is derived from the selected saved profile or the built-in DIRECT-only default. Source YAML is preserved verbatim. Sash overlays operational ports, controller credentials and LAN access, removes competing controller sockets/pipes and tunnels, and disables TUN before replacing the runtime configuration.

## Save, Apply and stop

Network preference changes, profile selection, edits and scheduled downloads only save state. They do not restart or reload Core. System-proxy intent is a separate OS action: enable requires a healthy owned Core; disable saves the off preference before attempting restoration and can be retried without another manifest write.

Routing-mode changes affect the running Core only. The controller call runs outside the application mutation queue and verifies Core ownership before and after the request. It does not save a preference or advance the state revision; Apply restores the mode from the selected profile.

Apply executes inside the daemon queue:

1. Generate the candidate from saved state and run Core's configuration validator against a private temporary file.
2. Restore the original system proxy. Failure leaves the current healthy Core running.
3. Stop the verified Core and ensure its controller is vacant.
4. Atomically publish the generated configuration.
5. Start Core, wait for its controller to report the expected version, and record the applied configuration. The first ready response completes startup.
6. Reconcile the saved system-proxy preference against the actual running port.

Validation failure leaves the old runtime untouched. Failure after stopping does not roll back saved edits; management stays available and reports the unapplied configuration. There is no general settings/profile/runtime compensation transaction.

Core stop cancels Core downloads and the configuration-test child while allowing profile downloads to finish. Daemon shutdown also cancels profile downloads, rejects later mutations, drains the active operation, restores proxy state, stops Core, acknowledges with `204`, then closes the listener. Cleanup failure keeps the daemon available for retry. An active binary swap completes or rolls back in order.

Unexpected Core exits trigger bounded proxy-restoration retries. Late child events cannot clear a replacement child. Status and proxy application verify that ownership remained the same across asynchronous probes. Unknown identity or uncertain termination preserves the PID record.

## Core updates

Core acquisition selects an unmodified upstream release artifact using official GitHub metadata. Mirrors transport bytes only. Initial URLs and redirects must be HTTPS and host-allowlisted; the archive is checked against its official SHA-256 while downloading. Archives are capped at 128 MiB and extraction at 512 MiB; ZIP paths cannot escape.

ZIP metadata and file contents are read through `yauzl`; Sash scans all entry names before creating output and streams the selected binary without buffering the archive. Both ZIP and gzip extraction exclusively create the temporary output, preserve pre-existing files/links, honor cancellation and remove only output created by that attempt. The ZIP reader closes before archive cleanup. Test fixtures generate ZIP archives with the development-only `yazl` writer; no second ZIP library ships with Sash.

`cpu-features.ts` detects usable x64 instruction sets once per process. Windows uses an available PowerShell 7 host and .NET CPU/OS intrinsics; Linux and macOS read kernel-reported features. Selection prefers supported v3, then v2/v1 assets. Unknown capabilities admit only compatible/v1 builds. ARM64 selects its native asset. Sash does not download multiple binaries to discover CPU compatibility.

Installed executables are trusted local files. Startup, configuration validation, updates, recovery and doctor do not hash them or run additional version-only probes. `state/install.json` holds `{coreVersion, installedAt, assetName?}`; a legacy `sha256` field is ignored. The running controller supplies version and readiness during the actual start.

App captures the applied configuration when Core is running, or saved configuration when it is stopped. Download and candidate config validation leave management responsive. Before publication the queue rechecks saved-state and runtime revisions.

Transient `coreUpdate` status reports the stage, target, start time, download activity and byte counts. The authenticated `GET /sash/core/update` endpoint returns this progress directly, avoiding controller/proxy probes for CLI progress reads. Completion or cancellation clears it; callbacks retain their own operation object and cannot modify a successor's progress. Supplemental progress failures never retry or alter the Core update mutation.

`core-update.ts` receives only the staged executable and runtime callbacks. Its fixed journal contains previous/target install records and these phases:

| Phase | Meaning |
| --- | --- |
| `prepared` | Rollback ownership is durable before moving files |
| `swapped` | New executable and install metadata are published |
| `restoring` | Rollback may have renamed the old binary back before restoring its metadata |
| `verified` | Health verification and restoration of the original running/stopped state succeeded |

The old executable remains `.bak` until the final phase. An explicit update while stopped performs one temporary start and then stops again. A first `sash start` installs and starts Core once, leaving it running. Failure restores the old binary/install record and, when applicable, the original running state. Recovery preserves unrecognized filesystem entries and blocks an unsafe replacement. A verified journal only needs cleanup; cleanup failure is logged without undoing a successful update or blocking normal startup.

Profile sources, metadata and settings never participate in this transaction. There is no deferred health decision, force-repair quarantine or coordinated second journal.

## Sash self-upgrades

`sash upgrade [version]` resolves the official npm release, validates the installation layout and the Node requirement, and lets npm replace the global package. `inspectSashUpgrade` is read-only and reports `{current, target, available, compatible, supported, installation, prefix, node, requiredNode, reason}`. Only an `npm-global` layout can be upgraded: the target comes from `https://registry.npmjs.org/@astralyn/sash/<tag>`, where the tag is `latest` or the exact version the user passed. Source checkouts, linked packages and other package managers report `supported: false` with a reason, never touch the network, and exit `1` outside `--check`. `available` is true for an explicit version that differs from the installed one and for `latest` when it is semver-greater; `compatible` is `!available || supportsNode(target, node)`.

Execution resolves the target, stops the local daemon when it was running, runs `npm install --global --prefix <prefix> --no-audit --no-fund @astralyn/sash@<exact version>` with the Node executable and the resolved npm CLI (no shell) under a scrubbed environment, and starts the daemon again only if it had been running. A failed install restarts the daemon on the previous version and reports the npm error. npm owns package integrity. Sash stages no package files and coordinates no other daemon: a run stops and restarts only the daemon of the data directory it was invoked in, and a daemon sharing the same package from another data directory loads the new version the next time it starts. `--check` only reads. `--json` prints one object; npm's own output goes to stderr in that mode.

`self-upgrade.test.ts` covers layout inspection, registry resolution and npm CLI resolution against a mocked registry and temporary directories. CI builds and packs once, and each supported platform runs the tests and installs that same artifact. Publication reuses the successful CI artifact without repeating acceptance and does not rebuild or repack.

## Windows integration

System-proxy ownership uses `state/system-proxy.json` with `prepared`, `applied` and `restoring` phases. Before OS writes it stores the original and target Windows registry values. Managed values are proxy enable/server, bypass list and PAC URL; Windows owns `AutoDetect`, which is observed but not written or compared for ownership.

Recovery restores an exact owned target, or original/target-compatible partial values from `prepared`/`restoring`. Third-party changes to an already applied target block restoration. Missing journals never authorize disabling an unrelated proxy. The per-user OS lock is independent of `SASH_HOME` so separate instances cannot write the registry concurrently.

Proxy operations use asynchronous, bounded helper processes. Inspection is cached briefly, shared while in flight, and reports unknown while a local write is pending. Unstable journal observations are retried once and never cached. Desired, Sash-applied and OS-observed proxy state remain separate.

After registry writes, WinINet notification tries the discovered PowerShell 7 executable and then the fixed Windows PowerShell host. Both `InternetSetOption` results are checked. If notification is unavailable, Sash preserves the registry operation's result and logs guidance to restart affected applications or repair PowerShell; it does not attempt undocumented `rundll32` entry points. Registry verification, ownership checks and rollback still apply.

Doctor queries the current user's `Internet Settings\\Connections` registry key and detects binary records beyond `DefaultConnectionSettings` and `SavedLegacySettings`. It reports their count and the per-connection management limitation without exposing blob contents or claiming those connections are active. Invalid or inaccessible registry observations remain unknown. This check neither decodes Windows-owned blobs nor writes per-connection settings.

Autostart uses a current-user registry entry and hidden launcher. See [Automatic Startup](./autostart.md). Other platforms report desktop integration as unsupported; portable CLI/Core primitives remain available.

## HTTP contract

`/sash/*` is implemented by the daemon, `/core/api/*` is the authenticated Core gateway, and `/ui/*` serves the bundled dashboard. The route table is the canonical API inventory.

| Endpoint | Method | Access / result |
| --- | --- | --- |
| `/sash/daemon/health` | GET | Public per-boot identity, PID and start time |
| `/sash/daemon/status` | GET | Public management/runtime snapshot; subscription URLs require control authentication |
| `/sash/events` | GET | Control; SSE full status snapshots and startup observations |
| `/sash/daemon/shutdown` | POST | Control; complete cleanup, then `204` and listener close |
| `/sash/web/bootstrap` | POST | Control; mint one-time browser handoff |
| `/sash/web/session` | POST | Redeem the handoff token supplied in the body |
| `/sash/web/continue` | POST | Public; exchange a previous generation's session token and boot identity for a current session |
| `/sash/core/start` | POST | Control; idempotent start, returning `alreadyRunning` and the applied `mixedPort` |
| `/sash/core/restart` | POST | Control; Apply saved state and restart Core |
| `/sash/core/stop` | POST | Control; stop Core, keep management; `204` |
| `/sash/core/update` | POST | Control; optional `{version}`, returns `{version}` |
| `/sash/core/update` | GET | Control; current update progress or `null` |
| `/sash/core/mode` | PUT | Control; `{mode}` changes running Core mode |
| `/sash/core/delay` | POST | Control; `{name}` requests one bounded outbound observation |
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

`/sash/events` sends `event: status` with `{schemaVersion: 1, sequence, status, autostart}` and a per-boot SSE ID. Each subscription starts from a complete snapshot; clients do not need a replay log. Mutations and Core preparation progress notify one shared observer, coalesced over 40 ms. A five-second shared sample detects external health/OS changes only while clients are connected; unchanged idle samples send no data. Desktop startup inspection is cached and cannot delay runtime events. Ten-second heartbeats renew/check browser authorization. At most 64 subscribers are admitted; a blocked writer retains only the newest pending snapshot. Disconnect and daemon shutdown release timers and streams.

The CLI watch uses the same direct, non-redirecting event client, verifies the discovered PID/boot identity, and converts events into the usual schema-2 CLI status. It rediscovers management after disconnection and observes stopped instances without starting them. Output cancellation aborts active readers before normal process exit.

Delay tests require an explicit `sash status --delay NAME`. The authenticated POST runs outside the state queue and verifies Core ownership before and after the controller request. It performs one non-retrying `/proxies/{name}/delay` request using direct transport, the fixed HTTP-204 test URL and a five-second Core timeout with request overhead. Success, timeout, missing names and failed tests are distinct validated observations; a Core replacement rejects the stale result. Client cancellation closes the daemon/controller request. Normal status and SSE observation never initiate these probes. `--watch --delay` samples independently every 30 seconds after completion and coalesces output while retaining only the latest observation.

Success bodies are resources; empty mutations return `204`. Errors use `{error: {code, message}}`. Unknown required fields or malformed successful payloads are rejected by the shared client. Raw settings editing and config reload routes do not exist.

The Core gateway permits queries, node selection and connection deletion. Managed configuration changes must use Sash controls. Mode uses `/sash/core/mode`; traffic and log WebSockets use `/core/api/traffic` and `/core/api/logs`.

## Security and persistence

The listener binds to `127.0.0.1`, validates loopback Host/Origin, and parses one canonical origin-form target for authentication and forwarding. Core requests use a direct dispatcher. Browser requests carry private per-boot sessions; the persistent CLI bearer never reaches the browser or Core gateway. Public health identity is not a credential. API responses are non-cacheable.

Static dashboard responses open a file once, derive its size from that descriptor and stream from the same descriptor. HEAD and disconnects close it. Missing dashboard installations receive explicit repair guidance; security and cache headers remain in effect.

`sash web` creates a 90-second single-use handoff in an owner-private local file. The browser removes its fragment before redemption, stores the session in tab storage and verifies the daemon boot. The daemon keeps only hashes, with bounded bootstrap/session counts and a twelve-hour sliding idle limit. Restarting Core preserves sessions. When a session is created, the daemon also writes its SHA-256 hash plus its boot id to `state/web-sessions.json` (mode `0600`); the next generation exchanges an old session token together with its old boot id at `POST /sash/web/continue` for a deterministic new session, so `sash restart`, `sash stop` + `sash start` and upgrades keep browser authorization. The file cannot authenticate anyone on its own. `GET /sash/daemon/health` advertises `webContinuation: {bootIds, expiresAt}` while such seeds exist, and protected routes answer `409` for a token that is a known but unexchanged previous session. Public health metadata is not a credential.

All helper children receive scrubbed environments. `sashd` is the one process that may inherit `GITHUB_TOKEN`/`GH_TOKEN`, because it performs release metadata and asset downloads for Core; Core, npm and every other child never receive it. Sensitive state/logs use POSIX `0600`; browser handoffs also use owner-only Windows ACLs. Atomic publication uses a same-directory temporary file, file fsync, rename and POSIX directory fsync. Windows sharing violations are retried without deleting unverified files. Use a local filesystem supporting atomic rename and hard links.
