# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Dashboard auto-authentication: on loopback controllers, Sash seeds the dashboard's endpoint list so it connects without prompting for credentials.

### Fixed

- `sash config set` for listener/auth keys (`controller`, `secret`, `tun`, `mixed-port`, `allow-lan`) now restarts a running core instead of attempting a hot reload that could never reach it.
- Download redirect targets are now validated against the host allowlist hop-by-hop; partial downloads are cleaned up on failure.
- Archive extraction hardening: dashboard tarballs only accept regular files/directories (no symlink/hardlink/path-traversal entries); core `.gz` decompression is streamed with a size cap; multi-executable zips prefer the `mihomo*.exe` entry.
- Startup health polling no longer spawns a process-identity probe on every tick (Windows PowerShell stall).
- `stop` keeps the pid record when a process's identity cannot be verified, instead of orphaning it.
- Removed a dead API client method that would hang on the core's infinite traffic stream.
- `sash logs -n` rejects non-positive-integer input; `controller` validation accepts IPv6 and enforces port range.
- `ALL_PROXY` is honoured via dispatcher constructor options without mutating `process.env`.
