# Releasing Sash

Stable releases are published from `.github/workflows/publish.yml` with npm Trusted Publishing (OIDC). The repository must not contain `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or another npm publishing secret.

## npm Trusted Publisher

One-time configuration on npmjs.com (package Settings → Trusted Publisher):

- Provider: GitHub Actions
- GitHub owner: `ming-kang`
- Repository: `Sash`
- Workflow filename: `publish.yml`
- Environment: empty
- Allowed actions: `npm publish` permitted (direct publishing)

All fields are case-sensitive and a connection cannot be edited after creation; delete and recreate it to change any field. npm can accept an upload while it is still processing the package; public availability may follow later.

## Release checklist

1. Update `package.json` and `package-lock.json` together:

   ```bash
   npm version x.y.z --no-git-tag-version
   ```

2. Move the release notes out of `## [Unreleased]` into `## [x.y.z] - YYYY-MM-DD` and keep an empty `[Unreleased]` section on top.
3. Run checks relevant to the change locally (`npm run typecheck`, `npm run lint`, affected tests). CI performs the complete release acceptance.
4. Commit and push the release change to `main`, then wait for CI to pass. CI runs static checks and the production audit once, builds one tarball, and runs tests plus installation smoke checks on Windows, Linux and macOS using that same tarball. The smoke checks verify the helper sizes and SHA-256 digests and run the installed host helper without elevation. The `npm-package` artifact is retained for 14 days.
5. Dispatch **Publish npm** from `main` with the same version:

   ```bash
   gh workflow run publish.yml --repo ming-kang/Sash --ref main -f version="x.y.z"
   gh run watch --repo ming-kang/Sash --exit-status
   ```

   The workflow checks that the requested version matches its source commit, selects successful CI for that exact commit on `main`, downloads its `npm-package` artifact and publishes it with provenance. Missing CI or an expired artifact stops publication; rerun CI to supply the artifact.

   A successful `npm publish` completes publication; the only following steps tag that workflow's source commit as `vx.y.z` and create the GitHub Release from the version's `CHANGELOG.md` section. Local `npm publish` prints the workflow instruction and exits. A green run records an accepted publication without promising immediate registry availability; there are no post-publication registry polls or runtime smoke tests.

## Platform helpers

The privileged helpers live in the Go module under `helper/` and build with
Go 1.27.4, the version pinned in CI. The helper must handle `--version`
before any privilege checks or service setup: print the embedded build
version to stdout and exit successfully without elevation or side effects.

`npm run build` includes `npm run build:helper -- --all`, which compiles the
`helper/` module for every platform target (`darwin`, `linux`, `win32` ×
`x64`, `arm64`). A target that fails to compile fails the build. For a
native-only build, run `npm run build:helper`. Binaries are named
`dist/sash-helper-<platform>-<arch>` with an `.exe` suffix on Windows.

Use `npm run build:release` for packaging and package smoke tests. It verifies
the selected Core archive against GitHub's release digest, extracts one
`dist/sash-tun-core-<platform>-<arch>[.exe]` per helper target (the baseline v1
Core on x64), and embeds that executable's SHA-256 and the Sash version in its
helper. The release manifest records the helper under `helpers.assets` and
its Core under `helpers.cores`, both with target, size, and SHA-256. A release
build fails without a pair. The publish workflow reuses the verified tarball.
A development build without a paired digest can report its version but cannot
install or start a privileged Core.

### Helper installation and updates

Only the administrator-consented install entry of the paired helper may call
`installConsentedHelper(files, { source, sha256 }, packagedCorePath)`.
Stop the old service, serialize installs, and provision the protected directory
before publishing. The install verifies the staged helper against the consented
helper digest and the staged Core against the digest embedded in the helper
build. Register/start the service only after both files are installed. The
service verifies the fixed protected Core again before each launch; a partial
install cannot launch a mismatched Core. Do not grant trust from a disk manifest,
legacy receipt, or daemon request.

Use the platform's fixed protected binary directory: `/usr/local/lib/sash`
on Linux, `/Library/Application Support/Sash/bin` on macOS, and
`Sash\core\bin` under the Windows ProgramData known folder. Resolve the known
folder through the OS, not inherited environment overrides. Do not accept
an install location from the daemon, user environment, or installer arguments.
Provision the fixed protected directories with administrative ownership and
non-writable permissions for ordinary users. Check the fixed directories and
their direct parents, and confirm that the installed files are regular and
protected. Reject symlinks or reparse points in these checked locations; do not
add a recursive audit to support arbitrary destinations. Keep the runtime data
directory separate and protected.

The helper's OS-authenticated local IPC endpoint carries both management and
controller traffic. Apply peer authorization to every connection, including
controller streams. `HelperClient.start(configText)` returns the PID and paired
Core digest, not a controller token. The Core's Unix controller socket lives
in a helper-only directory. Windows still uses a helper-private Core
loopback credential and verifies the connection belongs to the launched
Core; that credential never crosses the IPC boundary. The controller policy
and the helper's config validation still apply after peer authorization.

The running service does not import archives, resync, self-update, or accept a
custom Core. The daemon uses `HelperClient.start(configText)`; it does not
choose the Core. Platform `inspect()` should report the protected helper version
and `needsReconsent` for a legacy, unreadable, or damaged installation. Re-run
`sash tun helper install` with administrator consent after upgrading Sash or
to replace a legacy installation. Stop TUN before reinstalling. `sash core
update` updates only the ordinary-mode Core; it does not replace the TUN pair.

### Network recovery

Let Core manage its TUN interface, routes and DNS normally. The helper journal
records only exact network objects attributable to its Core session. Do not use
random routing table, rule priority, or device identifiers as a prerequisite
for recovery, and do not scan for conflicts or use before/after snapshots to
guess which objects to delete.

Implement `prepareNetwork()` and `recordCoreStart(pid)` to record actual
Core-created objects, not predicted state. Implement `recoverNetwork()` to
replay only those records on helper startup, before accepting IPC. No journal
is a successful no-op. Already removed objects need no action. If deletion of
a recorded object fails, keep its record and report the failure. Do not delete
unrecorded objects or block startup just because unrelated network objects
exist. This recovery cannot promise to remove objects created before they
could be recorded.

## Failed publication

If a pre-publication check fails, fix it and dispatch the workflow again. If `npm publish` fails, inspect its error before retrying; npm versions are immutable, and a processing notice or temporarily missing public version does not authorize another upload.

If `npm publish` succeeded and only tag/Release creation failed, rerun the failed **Tag and create the GitHub Release** job in the original run — tagging and Release creation are idempotent and retain the original run's source commit. Do not redispatch the entire workflow or rerun its successful publish job.

For an older workflow that failed after a successful upload, finish only its tag and GitHub Release using the original run's `headSha` and that commit's changelog. Do not republish the package. If an accepted package is defective, deprecate it and prepare the next patch version.
