# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Built-in zero-external-download WebUI dashboard (`web/` SPA built directly into `dist/ui/`) with real-time bandwidth charts, outbound mode switcher, proxy group selection with latency testing, subscription management, active connection monitor, routing rule browser, and live log terminal.
- Unified supervisor daemon (`sashd`) listening on port `19090` with `/sash/*` and `/core/*` dual namespaces.
- `/core/api/*` reverse proxy forwarding HTTP requests and WebSocket streams (traffic & logs) to the core controller with automatic server-side credential injection.
- Cross-platform OS system proxy support (`sash proxy on` / `off` / `status`) with automatic disable on core exit/daemon shutdown and boot-time crash reconciliation.
- Platform-native system proxy adapters for Windows (HKCU registry + WinINet refresh via PowerShell), macOS (`networksetup`), and Linux (GNOME `gsettings`).
- `sash logs --daemon` flag to inspect supervisor logs.

### Changed

- Rebuilt the built-in WebUI (`web/`) from the ground up: pure light minimalist design with a sidebar layout, Chinese/English interface switch (Chinese default, persisted), hash-based view routing, toast notifications and confirm dialogs replacing browser `alert`/`confirm`, and reworked overview, proxies, connections, rules, logs, subscription, and settings views.
- Process supervision: `sashd` manages the core process as a direct child, handling crash cleanup, automatic system proxy tear-down, and configuration reload orchestration.
- `settings.ts` added `daemonPort` (default 19090), `daemonSecret`, and `systemProxy` fields with automatic migration.
- `sash web` directly opens the built-in WebUI served by `sashd` on `http://127.0.0.1:19090/ui/`.

## [0.1.0] - 2026-08-31

### Added

- Initial release: full lifecycle management for a rule-based network core (`start` / `stop` / `restart` / `status` / `logs`).
- First-run bootstrap that downloads the latest core and web dashboard, with automatic fallback to public GitHub mirrors.
- Remote profile management: `sash sub set|update|show|unset` with hot reload of the running core.
- Integrated web dashboard served by the core's external controller.
- `sash update`: atomic core upgrades with automatic rollback.
- `sash upgrade`: self-upgrade via npm.
- `sash config`: managed keys (`tun`, `allow-lan`, `mixed-port`, `controller`, `secret`) with config regeneration and reload.
- Cross-platform data directory conventions with `SASH_HOME` override.
- Background process supervision with PID identity verification and safe, conservative termination.
- Dashboard auto-authentication: `sash web` opens the dashboard through its own setup deep-link, passing the controller address and secret as query parameters, so the panel connects without a sign-in step. No credentials are written to disk.
- README now documents behavior that was previously only in code: Sash-owned operational keys override profile values (`mixed-port`/`controller`/`secret`/`tun`/`allow-lan` etc.), the `sash.json` settings file (defaults, auto-generated secret, `secret regenerate`), restart-on-config-change and profile refetch semantics, `web --no-open` printing a credential-bearing URL, the fail-closed `stop` refusal mode, best-effort dashboard installation, and the pre-x86-64-v3 CPU workaround.

### Fixed

- `sash config set` for listener/auth keys (`controller`, `secret`, `tun`, `mixed-port`, `allow-lan`) now restarts a running core instead of attempting a hot reload that could never reach it.
- Download redirect targets are now validated against the host allowlist hop-by-hop; partial downloads are cleaned up on failure.
- Archive extraction hardening: dashboard tarballs only accept regular files/directories (no symlink/hardlink/path-traversal entries); core `.gz` decompression is streamed with a size cap; multi-executable zips prefer the `mihomo*.exe` entry.
- Startup health polling no longer spawns a process-identity probe on every tick (Windows PowerShell stall).
- `stop` keeps the pid record when a process's identity cannot be verified, instead of orphaning it.
- Removed a dead API client method that would hang on the core's infinite traffic stream.
- `sash logs -n` rejects non-positive-integer input; `controller` validation accepts IPv6 and enforces port range.
- `ALL_PROXY` is honoured via dispatcher constructor options without mutating `process.env`.
