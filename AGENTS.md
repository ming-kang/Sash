# Development Rules

Instructions for changing this repository. `docs/` explains Sash to users; this file explains how to work on it.

## Working Style

- Short and direct. No emojis in commits, issues, PR comments or code. No filler.
- When the user asks a question, answer it before editing or running commands.
- When responding to feedback, say whether you agree or disagree before saying what changed.
- Read whole files before wide-ranging changes; do not work from search snippets.

## Layout

Strict TypeScript ESM, Node >= 24. Entry point `src/cli.ts`; keep its `./node-version-guard.js` import first so nothing touches a Node 24 API earlier. `strict` + `verbatimModuleSyntax` + NodeNext are enabled, so suffixes and type-only imports are checked; no `any`.

- `src/commands/` — one module per command group, wiring only.
- `src/daemon/` — the sole application writer: mutation queue, HTTP router, handlers. The CLI and dashboard go through its API.
- `src/` root — `app-state.ts` (`sash.json`), `settings.ts`, `profiles.ts` / `profile-service.ts`, `runtime-lifecycle.ts` (Apply, Core and proxy order), `core.ts` / `core-update.ts`, `self-upgrade.ts` (npm install), `mihomo-config.ts` (generated `runtime/config.yaml`), `process.ts`, `api.ts` (direct controller client), `http.ts` / `github.ts` (downloads), `fs-atomic.ts`, `state-lock.ts`, `paths.ts`.
- `src/sysproxy/`, `src/autostart/` — Windows desktop integration.
- Tests sit beside their module as `*.test.ts`. `dist/` is generated (five single-file bundles via `scripts/build-dist.mjs`) and never edited by hand.

## Thin by Default

Sash does what the user asked and reports what happened. It does not re-verify its own decisions.

- **One validation point per value.** Settings live in `settings.ts`; profile YAML is parsed once and the Core's own pre-flight check decides whether a config is usable. Do not mirror a static type in a runtime validator, and do not re-validate a response this installation's daemon just produced.
- **Local state is not an adversary.** `sash.json`, install records, leases and lock files are written by Sash for this user. No MACs, content digests, byte-for-byte disk re-reads, directory identity gates or exact-key rejection on files Sash itself writes. Read them leniently, accept unknown fields, and treat unreadable files as absent or stale instead of halting.
- **No repeated probes.** Build-time checks belong in the build. Do not stat or hash `dist/`, walk dashboard manifests, or spawn probe processes at runtime or before an upgrade.
- **Fewer artifacts and processes.** Before adding a record, journal, phase machine, helper entry point or lock file, check whether an existing one already answers the question and whether a user could hit the failure it guards.
- **No shell-shape policing.** Do not reject user content over a heuristic the Core does not enforce (YAML alias caps, `listeners:` bans, share-link detection, private-IP redirect refusals).
- **Ask before deleting deliberate functionality.** Thin is about not re-verifying, not licence to remove a feature or a user-facing behaviour the user did not ask to remove.

## Safety Invariants

Load-bearing. Do not weaken without explicit user approval.

- **Never signal an unverified process.** `process.ts` verifies PID identity before any termination: path match on the expected executable, and `unknown` stays unverified.
- **Loopback never goes through a proxy.** Controller requests use the direct dispatcher; proxy environment variables apply to remote downloads only.
- **Credential hygiene.** Child processes get a scrubbed environment (no `GITHUB_TOKEN`, `NPM_TOKEN`, npm auth config). State files and logs are `0o600` on POSIX, and log appends do not follow symlinks.
- **Geodata is fetched by the Core, not by Sash.** mihomo downloads its geodata databases itself and ignores `HTTP_PROXY`, so a network without direct `github.com` access deadlocks a first start. The daemon retries the pre-flight check once with `geox-url` set to the mirror hosts, and that retried configuration is what it applies. Geodata is not digest-verified, exactly like the Core's own default fetch; do not extend this fallback to anything that Sash verifies.
- **Atomic writes.** State goes through `fs-atomic.ts`. Core updates keep the previous binary as `.bak` until the new one passes a health check.
- **Download trust.** Only `github.ts` allowlisted hosts are download origins, archives are verified against the GitHub release API's SHA-256 while streaming, and extraction rejects path traversal and enforces a size cap. These are the only integrity gates in Sash.
- **Self-upgrade goes through npm.** `sash upgrade` stops the daemon, runs `npm install --global` for one exact version, and starts the daemon again. npm owns package integrity; Sash does not stage, journal, probe or replace package files itself.
- **Subscription content is untrusted.** Parse it once as YAML and reject non-object documents before writing `config.yaml`; leave deeper acceptance to the Core.

## Commands

- After code changes: `npm run typecheck`, `npm run lint`, then the affected tests once. Do not repeat a passing check without a new reason.
- `npm test -- <name>` matches a test file name (`npm test -- contracts.test.ts`) or a path fragment; bare `npm test` runs everything. CI runs the full suite on Windows, Linux and macOS.
- Never test against the user's real instance: `SASH_HOME=<absolute path in a temp dir>`, non-default ports, no TUN. `npm run dev -- <args>` runs the CLI from source.
- After build or packaging changes run `npm run smoke:package` once; it installs and exercises the real tarball.
- UI changes: `scripts/ui-shot.mjs` captures routes. Check Chromium and Firefox, because flex metrics, form controls and fonts differ. If Firefox is not automatable, ask the user to look rather than declaring Chromium-only results done.

## Dependencies and Security

- Dependency and lockfile changes are reviewed code; establish what a new one does before adding it.
- Read `undici`'s changelog before upgrading it: dispatcher and redirect-interceptor APIs move between majors.
- CI runs `npm run audit:prod` (whole-tree `npm audit --audit-level=moderate`; runtime dependencies are bundled, so there is no separate production tree).

## Git and Release

- Stage explicit paths, only files you changed, and check `git status` before committing. Never `git add -A`, `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash` or `git commit --no-verify`.
- Do not commit unless asked. Message: `{feat,fix,docs,chore}: <imperative summary>`, one concern per commit.
- Record notable changes under the newest `CHANGELOG.md` section; released sections are immutable.
- Releases follow `RELEASING.md` — OIDC trusted publishing through `.github/workflows/publish.yml`. The repository must not contain npm publishing secrets. Version bumps and workflow dispatches need maintainer approval, and `prepublishOnly` is never bypassed.

## Upstream and Positioning

Hard requirements, not preferences.

- Never put the word "mihomo" in the package name, bin name, data directory or any user-visible identifier.
- User-visible copy (README, `package.json`, docs, npm and GitHub pages) positions Sash as a network toolbox for developers, learning and research; upstream names appear only in the README attribution section.
- Code, logs and internal docs may name upstream components factually (for example `mihomo-config.ts`); CLI help text follows the README's neutral wording.
- Never commit upstream binaries or upstream dashboard assets, and never bundle them in the npm tarball. Sash downloads unmodified release artifacts at install time.
- The upstream core repository's working branch is `Meta`; `main` holds unrelated content. Consult `Meta` for docs, config schemas and behaviour. Releases are branch-independent.

## User Override

If the user's instructions conflict with this file, get explicit confirmation first and only then proceed.
