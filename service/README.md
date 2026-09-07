# Sash Service native helper

Independently implemented MIT-licensed Go helper for the optional Windows service. The SCM service runs as LocalSystem (SYSTEM) and owns the privileged Core through verified process/job handles. The Sash daemon, dashboard, profiles, settings, provider/geodata downloads and system-proxy ownership remain ordinary-user responsibilities. No reference-project GPL code or Core binary is included here.

See [operations](../docs/usage.md#4-tun-mode), [wire protocol and configuration policy](../docs/service-protocol.md) and [third-party notices](../THIRD_PARTY_NOTICES.md). Installed code and private runtime files use the known Program Files folder (`SashService`), never user-writable ProgramData. One user SID and canonical absolute `SASH_HOME` are enrolled per machine.

## Build

Requirements: Node.js 24+ for the build wrapper and Go 1.26.7. From the repository root:

```sh
npm run build:service -- --arch amd64
npm run build:service -- --arch arm64
```

Cross-compilation produces `.native/windows-amd64/sash-service.exe` and `.native/windows-arm64/sash-service.exe`. Builds do not install/start the service or Core. `npm run build` remains the separate TypeScript/UI build and never implicitly requires Go.

The wrapper validates `package.json` SemVer and injects it as `main.version`; protocol version remains 1. It uses `-mod=readonly`, `-trimpath`, `-buildvcs=false`, `CGO_ENABLED=0` and stripped linker output. Reproducibility requires identical source, Go toolchain, target and flags. Do not commit `.native/` output. On matching Windows hardware, `sash-service.exe version` is a safe standalone identity check; do not invoke `run` (SCM-only) or administrative commands to test a build.

Each output directory includes `LICENSE`, `LICENSE.go-winio`, `LICENSE.x-sys`, combined `sash-service-LICENSE.txt` and `sash-service-NOTICE.txt`. Go 1.26.7's runtime BSD license has the same complete terms/attribution as the included `LICENSE.x-sys`. Preserve the combined license and notice files when distributing the helper. The release workflow attaches both architectures, notices and checksums to an existing approved release before npm publication; see the [release ordering](../docs/service-protocol.md#helper-builds-and-release-ordering). These binaries are not claimed to be Authenticode-signed.

## Native verification

Run in an **ordinary**, non-administrator shell. All data must be temporary; never use a real Sash instance or default runtime ports. For example, in PowerShell at the repository root:

```powershell
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('sash-native-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot | Out-Null
$previousHome = $env:SASH_HOME
try {
    $env:SASH_HOME = $testRoot
    npm run test:service
    npm run check:service
    npm run audit:service
    Push-Location service
    try {
        go test -mod=readonly -race ./...
    } finally {
        Pop-Location
    }
} finally {
    $env:SASH_HOME = $previousHome
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
```

`test:service` runs `go test -mod=readonly ./...`; `check:service` runs `go vet -mod=readonly ./...`; `audit:service` runs the pinned official `govulncheck` tool against reachable dependencies and the build toolchain's standard library. Go 1.26.4 produced reachable standard-library findings, so the module and release workflow require patched Go 1.26.7. Race tests additionally require a supported native Go race target and C compiler (on Windows amd64, a compatible MinGW-w64 compiler). A production CGO-free cross-build does not establish race-test support on the target. On non-Windows hosts, Go runs portable configuration/protocol/transaction fixtures; Windows-only files/tests are excluded, so that is not Windows native verification.

Fixtures cover bounded JSON/configuration policy, gateway allowlists, transactional rollback, native pipe identity/access, child environment and retained-job ownership. Child-process fixtures execute only the test executable, not a downloaded Core. Administrator/SYSTEM-only recovery ACL/job and protected Program Files maintenance-stage fixtures explicitly **SKIP** with an ordinary token. No SCM install/uninstall tests are performed by this suite. Do not elevate routine tests to make skips disappear: protected-stage tests can write administrator-owned locations.

## Source installation and pending manual verification

Build the package/UI and matching helper in an ordinary source checkout, then use the explicit helper option only in a same-user Administrator PowerShell:

```powershell
# Ordinary shell, repository root:
npm ci
npm run build
npm run build:service -- --arch amd64 # arm64 for Windows ARM64
npm link
sash status
```

```powershell
# Same Windows user, Administrator shell; preserve the same SASH_HOME.
# Replace this example path with the source checkout path.
sash service install --helper 'C:\path\to\Sash\.native\windows-amd64\sash-service.exe'
sash service status
```

```powershell
# Return to an ordinary shell with the same SASH_HOME:
sash start
sash web
```

Only then enable TUN in the dashboard. Windows direct-mode TUN is rejected; elevating the whole daemon is not a fallback. Install/repair/update use protected sibling maintenance staging to avoid overwriting the executing helper, restore owned proxy state and stop the previous daemon, and return without elevated daemon respawn. The idle service does not automatically start Core/TUN at installation or boot.

Real administrator install/repair/uninstall, interrupted-first-install recovery, update rollback, SCM boot lifecycle, cross-user/root rejection and TUN routing/DNS/network behavior require separate maintainer-approved testing in an isolated Windows VM. These remain pending; native fixture/build success is not a claim that these scenarios or all-platform CI passed. Never enable real TUN in automated smoke tests. See the operations guide for uninstall with preserved desired TUN and for service-private Core log limitations.

## Opt-in disposable VM acceptance

The prepared `.github/workflows/service-smoke.yml` requires a maintainer's manual dispatch and exact acknowledgement `I_ACKNOWLEDGE_DISPOSABLE_WINDOWS_VM_SERVICE_TEST`. Never invoke its harness on a workstation, self-hosted runner or existing Sash installation; never spoof hosted-runner environment variables. It builds the package and Go 1.26.7 helper, uses verified upstream Core staging, and would exercise administrator install/idle status, genuinely unelevated same-SID source CLI start/status/configs gateway/restart/stop, stopped-host repair and verified uninstall. TUN, system proxy and LAN access remain off. No secrets or private data/log artifacts are uploaded.

Safe host-only checks:

```sh
npm run test:service-vm-guard
# Windows-target build/vet only; these do not execute the launcher or touch SCM:
cd service
go build -mod=readonly -trimpath -buildvcs=false -o ../.native/service-vm-runner.exe ../scripts/service-vm-runner_windows.go
go vet -mod=readonly ../scripts/service-vm-runner_windows.go
```

The test-only launcher requires a usable unelevated UAC linked token and verifies the child token is non-administrator and has the enrolling SID. Hosted images without that token fail clearly before installation, never silently substitute an elevated client. No restricted-token fallback is implemented. This VM acceptance has **not been run**; ordinary-user proof remains pending. See the [acceptance contract and limitations](../docs/service-protocol.md#disposable-vm-acceptance-prepared-not-executed). `scripts/`, `.native/` and the launcher are excluded from the production npm tarball.
