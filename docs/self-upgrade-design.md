# Sash self-upgrade implementation contract

`sash upgrade [version]` updates the Sash package, daemon and bundled dashboard in one operation. `sash update [tag]` updates Core. This contract defines the complete upgrade experience tracked in `ROADMAP.md`.

Implementation tracking:

- [x] Shared installation detection and exact package/Node version validation.
- [x] Installation instance registration and stable daemon startup identity.
- [ ] Runtime reservation, private handoff and browser continuation.
- [ ] Complete npm staging, standalone worker and recoverable package/bin activation.
- [ ] Command wiring and end-to-end failure/recovery verification.

## Installation and preparation

- Identify the executing package and its canonical npm global prefix. Source checkouts, linked packages and installations owned by another package manager receive instructions for their actual installation method.
- Resolve the default target from the official npm `latest` tag; accept an explicit exact version. Check package identity, Node compatibility and the runtime handoff protocol before stopping anything. An already-current installation is a successful no-op.
- `--check` reads version information without starting management or changing the installation or application state. JSON output distinguishes availability, compatibility and unsupported installation methods.
- Let npm prepare the complete candidate dependency tree in an isolated staging prefix on the installation's filesystem. Use an explicitly selected registry and isolated npm configuration, scrub child credentials, and retain normal npm integrity verification.
- Validate the staged CLI and dashboard and prepare all recovery material while the original runtime remains available. Activation must not need a working Sash proxy or another network download.

## Durable installation transaction

The updater runs from a standalone Node helper outside the package directory. The helper must continue to work while the installed package is absent, replaced or invalid. Bundle its dependencies when building Sash and verify that the copied helper runs independently.

Stage and activate the npm-prepared package and its bin shims as fixed filesystem roles. Retain the original package and shims until every restored runtime passes health and exact-version checks. Record decisions through atomic, bounded journals; authenticate package slots against their recorded manifests before replacing or removing them. Keep npm's installation layout and invalidate its disposable installation cache through the owned package directory's modification time.

Before moving the active package, install temporary recovery shims that reach a durable launcher outside it. A crash between the old-package rename and candidate activation must leave `sash upgrade` usable. Restore the appropriate npm shims only after the active slot is verified. Keep the recovery entry available until all shim restoration is confirmed.

Transaction stages are preparation, instance reservation, stopping, activation, runtime restoration, commit and cleanup. Recovery inspects both the journal and actual owned filesystem slots; it resumes a committed cleanup or restores the prior installation and runtime. Cancellation before activation releases reservations; cancellation or failure afterward rolls back. Unverifiable process or file ownership preserves the transaction for retry.

## Instance coordination

- Use an installation-wide upgrade lock and a startup admission gate. A second upgrade or a competing daemon start cannot enter the package swap.
- Register daemon instances against their canonical installation and data directory. Discover all instances using that installation and verify their PID, boot identity, installation identity and authenticated control API before requesting changes.
- Reserve every affected instance before stopping any of them. Reservations close mutation admission and drain the current mutation. Preparation failure releases earlier reservations.
- The daemon remains the sole writer of application state and runtime handoff files. The updater manages installation files and coordinates authenticated lifecycle requests.
- Store runtime snapshots and credential material privately in each data directory. The installation journal contains installation decisions and instance references, not subscription content or credentials.
- Never signal an unverified process. Newly spawned children use owned handles; existing daemons use verified authenticated shutdown. Unknown live owners prevent replacement.

## Runtime continuity

Snapshot the actual applied configuration separately from the saved manifest. Restore the original stopped, management-only or Core-running state, the runtime routing mode and selected nodes, and the owned system-proxy state. Preserve pending profile and network edits without implicitly applying them. Keep the Core version and binary unchanged during a Sash upgrade.

Restart through the verified new package and the supported Node executable, then check the daemon's own startup version, instance identity and Core readiness. Preserve the data directory and working login startup registration. Failed installation or health verification restores the previous package and the same runtime snapshot without depending on network access.

Treat browser authorization as an explicit handoff: ordinary daemon restarts continue to invalidate sessions. A short-lived upgrade continuation may exchange an existing private session for a new boot-bound session only for the reserved upgrade. Public health identity never authorizes that exchange.

## Verification

Use isolated npm prefixes, data directories, OS integration adapters and non-default ports. Cover stopped, management-only and Core-running upgrades; multiple instances; saved-but-unapplied edits; runtime modes and node selections; proxy and login startup restoration; browser continuation; unavailable registries and incompatible Node versions; damaged candidates; health failures; concurrent starts/upgrades; cancellation and process exit at every durable boundary.

Verify recovery by invoking the installed bin shim while the active package is absent. Verify the resulting package with npm inspection, CLI help/version, daemon version and an isolated start/status/stop cycle. Exercise Windows path quoting, spaces and Unicode, and verify that helpers and journals neither expose credentials nor terminate an unrelated process.
