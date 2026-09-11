# Development Rules

## Design

- Delete unnecessary concepts and layers. Before adding a record, process, phase, helper or lock, identify the concrete failure and check whether existing state already handles it. Ask before removing deliberate functionality.
- `src/daemon/` is the sole application writer; CLI and dashboard use its API. `src/commands/` wires commands only.
- Validate settings in `settings.ts`. Trust typed responses from this installation's daemon; do not mirror static types with runtime validators.
- Treat Sash-written state as local: accept unknown fields and treat unreadable records as absent or stale. Do not add MACs, digests, exact-key schemas, filesystem identity checks or disk re-reads to verify Sash's own writes.
- Build checks belong in the build. Do not inspect `dist/`, walk dashboard manifests or spawn probe processes at runtime or before an upgrade.
- Leave configuration acceptance to Core: no YAML alias caps, `listeners:` bans, share-link heuristics or private-IP redirect refusals.
- Use strict TypeScript ESM, Node >= 24 and no `any`. Keep `./node-version-guard.js` as the first import in `src/cli.ts`. `dist/` is generated; never edit it.

## Safety

Do not weaken these boundaries without explicit user approval.

- **Processes:** `process.ts` must verify the PID's executable path before every termination. Unknown identity never authorizes a signal.
- **Transport:** loopback/controller requests use the direct dispatcher. Proxy environment variables apply only to remote downloads.
- **Credentials:** scrub child environments, including npm auth config, `GITHUB_PAT` and unrelated tokens. Only `sashd` may receive `GITHUB_TOKEN`/`GH_TOKEN` for release downloads; Core, npm and helpers receive no credentials. Never log secrets. State and logs use POSIX `0600`; log appends never follow symlinks.
- **Persistence:** state writes use `fs-atomic.ts`. Core updates retain the previous binary as `.bak` until the new one passes its health check.
- **Downloads:** origins must be allowlisted in `github.ts`; verify archives against the release API's SHA-256 while streaming. Extraction rejects path traversal and enforces a size cap. These are Sash's only integrity checks.
- **Geodata:** Core fetches it itself and cannot use a proxy it has not started. Retry a geodata pre-flight download failure once with mirror `geox-url` values, then apply that configuration. This fallback uses no digest and never applies to verified downloads.
- **Self-upgrade:** run npm's global install for one exact version while Sash keeps serving the proxy; only then restart Sash (`--no-restart` skips restarting). npm owns package integrity. No package staging, journals, probes or manual file replacement.
- **Subscriptions:** parse untrusted YAML once and reject non-object documents before publication. Core's pre-flight check decides deeper acceptance.

## Copy

Use the same vocabulary in CLI output, help, errors and both dashboard locales:

| Concept | User-facing word |
| --- | --- |
| Background process | Sash (never sashd, daemon or management; disk names stay `sashd.*`) |
| Network engine | Core |
| OS proxy setting | system proxy (name Windows when reporting its setting) |
| Inbound port | proxy port |
| Data directory | data folder |
| Generated config | core config |
| Management HTTP API | local API |
| Saved configuration | profile |
| Login startup | start at login |

- CLI keys: lower case, complete words, at most two words. Dashboard headings: Title Case. Booleans: `on`/`off`. Known absence: `not installed`, `off` or `none`; `unknown` means observation failed and must include the reason.
- Single sentences have no trailing period. Join facts with ` · `; introduce consequences or next commands with ` — `. Errors explain what happened and what to do. Unreachable invariants start with `internal error:` and ask for a report.
- Prose must not expose `desired`, `applied`, `observed`, `revision`, `journal`, `snapshot`, `identity`, `ownership`, `gate`, `admission`, `lease`, `mutation`, `handoff`, `transaction`, `protocol`, boot ids, tokens or hashes. PIDs appear only where useful for troubleshooting and always in `--json`.
- JSON fields and values, `doctor --json` check ids and exit meanings are frozen APIs: 0 success, 1 failure, 2 incomplete observation. Copy changes must preserve them.

## Workflow

- Be short and direct; no filler or emojis in commits, issues, PR comments or code. Answer questions before commands or edits; state agreement or disagreement before responding to feedback. Read whole files before broad changes.
- Run commands with Git Bash or PowerShell 7 (`pwsh`), not PowerShell 5.
- After code changes: `npm run typecheck`, `npm run lint`, then affected tests once. Tests live beside modules as `*.test.ts`; `npm test -- <filename-or-path-fragment>` filters them. Do not repeat passing checks without a new reason.
- Tests use an absolute temporary `SASH_HOME`, non-default ports and no TUN, never the user's instance. `npm run dev -- <args>` runs source.
- Build/packaging changes require `npm run smoke:package` once. UI changes require Chromium and Firefox checks with `scripts/ui-shot.mjs`; if Firefox cannot be automated, ask the user to inspect it.
- Review dependency and lockfile changes; understand a dependency before adding it. Read `undici`'s changelog before upgrading it. CI's `npm run audit:prod` audits the whole dependency tree because runtime dependencies are bundled.
- Do not commit unless asked. Check `git status`, stage only explicit paths you changed, and use `{feat,fix,docs,chore}: <imperative summary>`, one concern per commit. Never use `git add -A`, `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash` or `git commit --no-verify`.
- Put notable changes in the newest `CHANGELOG.md` section; released sections are immutable. Follow `RELEASING.md`: version bumps and workflow dispatches need maintainer approval. Publish through `.github/workflows/publish.yml` with OIDC; no npm publishing secrets or bypassing `prepublishOnly`.
- Confirm conflicts with these instructions before overriding them.

## Upstream

- Position Sash as a network toolbox for developers, learning and research. Never use "mihomo" in package/bin names, data folders or user-visible identifiers. Upstream names belong only in README attribution; code, logs and internal docs may name them factually.
- Never commit or bundle upstream binaries or dashboard assets; download unmodified release artifacts at install time.
- Consult the upstream Core repository's `Meta` branch for code, schemas and behavior; `main` is unrelated. Releases are branch-independent.
