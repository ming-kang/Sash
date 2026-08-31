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
