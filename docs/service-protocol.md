# Windows Service Protocol (implementation contract)

Sash's Windows service owns only the privileged Core. The user daemon remains responsible for profiles, settings, system-proxy ownership and its HTTP/WebSocket gateway. This protocol is independently implemented; reference projects supply design context, not copied code.

## Deployment and trust

- Service name: `SashService`. One enrolled Windows user and canonical absolute `SASH_HOME` per machine in v1. Other roots/users fail with a conflict, never take over.
- Native helper: `sash-service.exe`, built from `service/` (Go). Protected installed helper/Core and policy directories use Windows known folders and administrator/SYSTEM-only modification ACLs. User-readable policy must never contain the private Core controller secret.
- Native commands are listed below. Administrative operations require an elevated same-user token, operate on protected destinations, and never start Core/TUN themselves. Install is also the administrative repair/Core-refresh entry point. The ordinary IPC protocol never accepts executable paths or executable bytes.
- The service runs as LocalSystem (SYSTEM); the user daemon and profiles/system-proxy state remain ordinary-user owned. Installed code and private data are below the known Program Files folder, normally `C:\Program Files\SashService`, not ProgramData. Fixed roles include `sash-service.exe`, `private/core.exe`, `private/policy.json`, `private/runtime/config.json`, `private/core.log` and `private/service.log`. The private controller secret and protected file logs are not exposed by public status.
- Unprivileged `bridge` authenticates the actual named-pipe server against the SCM service process before forwarding traffic. Pipe server authenticates the enrolled client SID using Windows token identity, rejects remote clients, and uses a DACL excluding client create-instance rights. A native bridge avoids Node's broad generic pipe-open permissions.
- SCM service is available while idle, but does not autonomously start Core at boot. Child ownership uses retained Windows process/job handles; service death must terminate its owned child tree. No PID-only or process-name termination.
- The protected Core is provisioned by an explicit administrator operation from Sash's verified release staging. Changed protected bytes/registration identities fail closed. Approved binary updates retain rollback data until a managed start passes readiness.

## Native console commands

| Command | Purpose |
| :--- | :--- |
| `version` | Standalone `{protocol,version}` identity; no service/Core start. |
| `privileges --root <root>` | Report actual token elevation and same-user root ownership before staging or maintenance. |
| `status --root <root>` | Read-only SCM/pipe observation; fail closed on corrupt or orphaned protected installation. |
| `repair-status --root <root>` | Administrative recovery of verified orphaned install journals after confirming SCM absence; returns enrollment metadata without inventing Core observation. Not a read-only status probe. |
| `bridge --root <root>` | Ordinary-user authenticated pipe-to-loopback bridge. |
| `stage-maintenance --root <root>` | Administrative protected sibling copy; returns `{protocol,helperPath,directory}` below `Program Files/SashService-maintenance-<64 hex digits>`. Prevents overwriting the executing installed helper. |
| `cleanup-maintenance --root <root> --directory <protected-stage>` | Administrative cleanup of only a verified maintenance sibling and its fixed helper file; unknown contents are preserved. |
| `install --root <root> --core <approved-source-exe> --core-version <version>` | Enroll/install, repair or refresh approved Core using protected staging; returns `{protocol,installed:true}`. |
| `uninstall --root <root>` | Remove after verified shutdown; returns `{protocol,installed:false}`. User profiles/settings and desired TUN remain untouched. |
| `run` | SCM-only service entry; rejected from a normal console. |

`repair-status` must run from the detached protected maintenance helper and may restore protected journals. It is an administrative recovery boundary, not permission to adopt another user's/root's enrollment or an unknown SCM registration. User-facing commands are `sash service install [--core-version V] [--helper PATH]`, `sash service status [--json]`, `sash service uninstall`, and service-mode `sash update [--version V]`. No auto-UAC, elevated daemon respawn, boot-time Core launch or silent direct fallback is allowed.

## Local bridge

The helper prints exactly one startup JSON line to stdout:

```json
{"protocol":1,"controller":"127.0.0.1:49152","secret":"<per-bridge-random-token>"}
```

It then serves HTTP/WebSockets on that ephemeral loopback listener. Every request requires the bridge token. Stdin EOF closes the bridge. No token is persisted or passed in argv; stdin/stdout are inherited only by the user daemon. The bridge injects the canonical root identity into pipe requests and strips its local bearer before forwarding. Diagnostics go to stderr.

Reserved control namespace: `/sash-service/*`. Other requests are Core-controller requests, governed by a service-side method/path/body allowlist. In particular arbitrary config reloads, binary upgrades, provider-file publication and alternate controller listeners are forbidden. The private Core bearer is never returned to the user process, including in `/configs` responses. Both hops are direct and loopback/local only.

## Messages

Every non-success response uses `{error:{code,message}}`. Version/protocol incompatibility, root/owner mismatch and unavailable service are explicit failures, not permission to run a direct fallback.

`GET /sash-service/status` and the native `status` command return:

```json
{
  "protocol":1,
  "supported":true,
  "installed":true,
  "running":true,
  "compatible":true,
  "version":"0.1.0",
  "root":"C:\\Users\\Example\\AppData\\Local\\Sash",
  "serviceInstance":"<random-per-service-boot-id>",
  "coreVersion":"v1.19.30",
  "generation":0,
  "core":{"running":false}
}
```

The example describes a responsive service with stopped Core. When SCM is unavailable, native status omits `core`, `generation` and `serviceInstance`; ordinary callers do not read private enrollment, while an administrator can obtain verified root/approved-version metadata. Do not infer Core stop from SCM availability alone.

Core state, when running: positive `pid`, ISO `startedAt`, `healthy` boolean, `version` when known, optional boolean `tunActive`. An unavailable observation must throw/report error, never be synthesized as stopped. `generation` changes on owned Core replacement/exit. `serviceInstance` plus generation identify an instance beyond PID reuse.

`RuntimeBundle`:

```text
config: JSON object (Core YAML represented as parsed JSON, never raw path input)
assets: [{ path: relative destination, data: base64 }]
```

Bundle caps are 8 MiB for parsed config, 8 MiB per provider, 64 MiB per geodata file, and 128 MiB total decoded config/assets (at most 512 assets). The wire request cap is 176 MiB, including base64 expansion. The user process materializes HTTP providers with a shared 60-second budget, preserving probe settings but removing fetch URLs/headers from the native bundle. Required known geodata is read from regular local files or a separate private `SASH_HOME/service-assets` cache; cache misses use only `MetaCubeX/meta-rules-dat@latest` official release metadata and SHA-256-verified allowlisted downloads, with a separate shared 90-second geodata budget. The service never downloads missing geodata. Provider refresh rebuilds the fixed user config and uses session-proven native reload; failed refresh retains the running Core and retries at a bounded interval. `ServiceRuntime.refreshProviders(): Promise<void>` is the user-side operator refresh hook, not a raw Core file-provider PUT.

JSON parsing rejects duplicate keys, unknown command fields, trailing values and nesting deeper than 32 levels. Asset paths are at most 220 characters and three slash-separated segments, with bounded safe segments; traversal, absolute paths, backslashes, alternate streams, Windows reserved names and case-folded aliases are rejected. File providers must have declared `providers/` paths and matching bundled data. Known geodata roles are `geoip.dat`, `geosite.dat`, `country.mmdb` and `ASN.mmdb`.

The service independently validates the final parsed config and asset roles, sizes and relative paths. It emits JSON config (valid Core-format YAML) under private protected storage. Sash-owned listeners/credentials are enforced; the private controller bearer is injected there. Filesystem-capable options, provider paths, certificate paths and alternate control/update routes must not bypass the protected runtime. Unsupported unsafe configuration is rejected before publication rather than silently dropped. Source profiles stay user-owned and unchanged. The allowlist supports bounded standard proxy definitions (`direct`, `ss`, `socks5`, `http`, `vmess`, `vless`, `trojan`, `hysteria2`, `wireguard`), supported transport options and inline credentials, proxy groups/rules, file/inline providers, packet sniffer options, DNS and Sash-managed TUN. Proxy lists are capped at 20,000, groups/string lists at 10,000 and provider maps at 512 entries. Rule YAML is parsed and normalized to strict JSON payload arrays before privileged publication and geodata checks; text payloads are bounded and normalized with ambiguous escapes rejected. MRS rule providers are allowed only for `domain` or `ipcidr`, not opaque `classical` rules. This is not unrestricted Core compatibility: unknown options, filesystem-backed certificates, implicit privileged geodata downloads and unapproved provider URLs fail explicitly. DNS listeners, if supplied, must be loopback; the private controller is always replaced with the service-owned endpoint and secret.

- `POST /sash-service/validate`: `{bundle}`; validate protected candidate via Core `-t`; return `204`. Does not start a listener/TUN.
- `POST /sash-service/start`: `{session,bundle}`; start approved Core, wait for two readiness observations, return full status. `session` is 32 random bytes in hex, persisted privately by sashd before start for crash recovery. A different active session conflicts.
- `POST /sash-service/stop`: `{session,serviceInstance,generation}`; stop only the matching owned instance; return full stopped status. Confirmed stopped is idempotent. Uncertain ownership is an error.
- `POST /sash-service/reload`: `{session,serviceInstance,generation,bundle}`; protected config/resource publication, private-controller reload, verify desired TUN; compensate on failure; return full status.

The service serializes mutations. Reload/start publication preserves prior protected state on failure, including incomplete rollback evidence. A service-backed Core never writes `state/sash.pid`, which remains direct-child discovery metadata.

## Controller allowlist

Read-only telemetry/version/config/proxies/rules/connections and their WebSocket streams remain supported. Deliberate mutations are limited to outbound mode/log-level, selecting a proxy group member, closing connections, and refreshing already-approved providers. The service parses and validates mutation bodies, not just paths. Core upgrade/restart/config-path/payload APIs and alternate listeners remain private service operations.

## TS integration

- Structural `CoreRuntime` retains start/stop/restart/status/isRunning/ownedCoreSnapshot/ownsCore. Service adapter also supplies controller endpoint, generated-config validation and reload hooks.
- Production daemon startup asynchronously discovers the backend before constructing its app. An installed but unavailable/incompatible/mismatched service is fail-closed, not direct mode.
- Recovery restores user system proxy before stopping an identified leftover service Core, then recovers existing user journals. Service session state is atomic/private. Explicit stop/shutdown may retire an old-boot proof only after fresh authenticated full status proves the new compatible host has stopped Core; polling still reports boot changes as ownership loss. Active/unknown Core, corrupt proof and identity conflicts preserve evidence. Administrative install/update may first use internal `start-service --root <root>` to start only an existing confirmed-stopped SCM host, after validating enrollment SID/root, fixed image/account and protected helper hash/ACL. This does not replace enrollment or executable bytes before graceful daemon shutdown and proxy cleanup, and never launches Core. Uninstall does not use this preflight: repair via install first if graceful shutdown is blocked. Protocol 1 is the wire compatibility boundary across helper release versions; running status reports the actual server version, and binary trust/owner/PID checks remain mandatory.
- Service availability loss invalidates observed runtime, releases user proxy through the existing lifecycle queue, and preserves uncertain ownership. A later request cannot mistake it for a safely stopped child.
- Windows TUN requires service mode. Non-Windows direct mode remains unchanged in this first implementation.
- Core upgrades in service mode require an explicit elevated administrative refresh; do not run the existing direct verification supervisor against a privileged service installation.

This document fixes the inter-module wire contract. Implementation, tests and the operations guide must remain aligned; it is not a statement that a service has been installed or real TUN connectivity has been tested.

## Helper builds and release ordering

`npm run build` builds only TypeScript and the bundled UI; Go is required only by `build:service`, `test:service`, `check:service` and `audit:service`. Native builds use Go 1.26.7, read the strict SemVer from `package.json`, inject `main.version`, disable CGO and VCS metadata, and trim source paths. Outputs are ignored `.native/windows-amd64/sash-service.exe` and `.native/windows-arm64/sash-service.exe` plus full license/notice files. Matching toolchain, source, architecture and flags are required for reproducibility. See [native build/test instructions](https://github.com/ming-kang/Sash/blob/main/service/README.md).

With explicit maintainer release approval:

1. Follow `RELEASING.md` to prepare an approved version/tag and an existing GitHub release. Do not dispatch artifact publication on a branch or with a different package version.
2. Manually dispatch `.github/workflows/service-artifacts.yml` **on the existing `v<package.json version>` tag ref** (there is no version input). It checks the tag/checkout commit, tests native fixtures, vets, runs the pinned official vulnerability scanner and builds both Windows architectures with pinned Go 1.26.7. Privileged fixtures may skip; this is not SCM/TUN validation.
3. Attach `sash-service-windows-amd64.exe`, `sash-service-windows-arm64.exe`, `sash-service-LICENSE.txt`, `sash-service-NOTICE.txt` and `sash-service-SHA256SUMS.txt` to that existing release. The workflow rechecks the remote tag commit and all existing asset collisions before uploading missing files. Identical assets are retained; different bytes fail without replacement (`--clobber` is never used). It neither creates releases nor moves tags. Partial uploads can be resumed only with identical bytes.
4. Confirm matching official asset metadata exposes SHA-256 digests, then separately dispatch the existing approved npm OIDC workflow (`.github/workflows/publish.yml`) as specified in the release runbook. Helper attachment must precede npm publication so new npm installations can resolve the matching helper. No helper or Core binaries enter the npm tarball.

Checksums/notices accompany binary redistribution; GitHub asset-digest verification is mandatory for npm helper downloads and is not an Authenticode-signing claim. Source installs may explicitly select a version/protocol-matching `--helper`, or use the matching local `.native` output. No workflow was dispatched as part of documenting this procedure. Real VM administrator install/uninstall, boot recovery and TUN routing/DNS/network verification remain pending.

## Disposable VM acceptance (prepared, not executed)

`.github/workflows/service-smoke.yml` is an opt-in **manual** acceptance job, not a push/PR gate or release workflow. A maintainer must review the selected repository ref and dispatch it in `ming-kang/Sash` with acknowledgement `I_ACKNOWLEDGE_DISPOSABLE_WINDOWS_VM_SERVICE_TEST`. It uses only GitHub-hosted `windows-latest`, read-only contents permission, pinned actions and Go 1.26.7, with a 25-minute job limit. There are no publishing permissions, supplied secrets or artifact uploads. Optional `coreVersion` accepts only a stable `vX.Y.Z` tag; empty selects the existing verified upstream latest-release machinery. It does not substitute checksums or accept arbitrary download origins.

The harness refuses local/self-hosted/non-Windows execution, missing acknowledgement, existing `SASH_HOME`, service registration, protected installation/maintenance siblings, default user root or detectable active user instance before installation. It additionally checks an administrator token and Microsoft virtual-machine OS information. These environment/OS checks are accident-prevention gates, not cryptographic proof of a disposable machine: never spoof them locally. GitHub's hosted-runner lifecycle supplies disposability.

Before creating state, the test-only `scripts/service-vm-runner_windows.go` must launch a child with the administrator's same-SID **unelevated UAC linked primary token**. The child checks its own token elevation (including query errors), administrator membership and SID before launching Node. No elevated fallback or silent skip exists. A hosted image without a usable linked token fails at `ordinary-token-proof` before root allocation/install; this implementation deliberately does not manufacture a restricted-token fallback. Linked-token availability and actual ordinary-user execution on the hosted image remain unverified. The launcher is compiled from the existing `service/go.mod` dependency graph, adds no dependencies, and is outside the production helper/IPC and npm tarball.

On a compatible disposable VM the job would check:

1. Fresh private `SASH_HOME` under `RUNNER_TEMP`, owned by the current user SID (not the administrator group), with a new non-inherited user-only ACL. Existing directories never have ownership/ACLs changed. Atomic settings seed TUN, system proxy and LAN access off, with three distinct non-default free loopback ports.
2. Actual source CLI `service install --helper <local build>` as administrator, using verified release Core staging. Ordinary `service status` plus native observation must show an idle host with stopped Core; stopped Core does not invent a `tunActive` value.
3. Same-SID ordinary CLI `start`, `status --json`, `restart` and authenticated `/core/api/configs` requests. The built-in DIRECT-only profile uses no subscriptions, providers or geodata. Generated config must omit TUN; live CLI/native status and gateway config must explicitly observe TUN inactive. No real TUN is ever enabled.
4. Fault injection stops only the just-created, native-verified service registration after checking its fixed SCM image/account, while the user daemon is live. Administrative install/repair must restore an idle host and allow another ordinary start. This is stopped-host recovery, not reboot, routing or full update-rollback coverage.
5. Ordinary verified stop, public administrative uninstall, SCM absence and removal of the harness's protected root. Failure cleanup uses only public stop/uninstall for a confirmed harness installation. Partial install, uncertain ownership, deadline or cleanup failures retain evidence; there is no PID/name kill, forced deletion or unconditional workflow cleanup.

Only fixed phase/check labels are reported. Subprocess output, roots, user data, bearer tokens and private Core logs are never uploaded or printed by the harness. Private user state is left on the disposable VM for its lifecycle to retire. Deadlines do not terminate unverified processes or race cleanup against an operation still running; the job timeout/disposable VM is the final bound. Ephemeral port allocation has the usual release-to-bind race and fails normally on collision.

This harness has **not been executed in a VM**. Guard unit tests, launcher compilation and lint/type checks do not establish ordinary-user service acceptance. TUN routing/DNS, reboot behavior, cross-user conflict scenarios and interrupted-install/update rollback remain separate pending acceptance work.
