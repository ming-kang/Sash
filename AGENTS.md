# Development Rules

## Conversational Style

- Keep answers short and concise. No emojis in commits, issues, PR comments, or code.
- No fluff or cheerful filler text. Technical prose only, be direct.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback, explicitly say whether you agree or disagree before saying what you changed.

## Project Layout

Sash is a strict TypeScript ESM CLI (Node.js >= 24). Entry point: `src/cli.ts`.

- `src/commands/` — one module per command group; thin wiring only, no business logic.
- `src/` root modules — `paths.ts` (data dir layout), `settings.ts` (`sash.json`), `core.ts` (core download/install), `webui.ts` (dashboard asset path resolution), `mihomo-config.ts` (config.yaml generation), `process.ts` (daemon lifecycle, PID identity), `api.ts` (external-controller client), `http.ts` / `github.ts` (networking, mirrors), `fs-atomic.ts`.
- Tests live beside their module as `*.test.ts`. `dist/` is generated; never edit it manually.

## Code Quality

- Read files in full before wide-ranging changes. Do not rely on search snippets for broad changes.
- ESM with NodeNext: relative imports always carry the `.js` suffix; type-only imports use `import type`.
- No `any` unless absolutely necessary. Check node_modules for external API types; don't guess.
- Keep the first import of `src/cli.ts` (`./node-version-guard.js`) above all others; it must run before any Node 24+ API is touched.
- Inline single-line helpers that have only one call site.
- Always ask before removing functionality or code that appears intentional.

## Upstream & Positioning Rules

These are hard requirements, not style preferences.

- **Naming**: the upstream project forbids derivative project names from containing the word "mihomo". Never rename the package, bin, data directory, or any user-facing identifier to include it.
- **User-visible copy** (README, package.json `description`/`keywords`, docs, npm/GitHub pages): position Sash as a network toolbox for developers, learning, and research. Do not mention upstream project names in taglines or feature copy; upstream names belong only in the attribution section at the bottom of the README.
- Code, log messages, and internal documentation may name upstream components factually (e.g. `mihomo-config.ts`), but CLI help text should follow the README's neutral wording where practical.
- The upstream core repository's working branch is `Meta`; `main` is a decoy with unrelated content. Consult `Meta` for docs, config schemas, and behavior. Releases are branch-independent.
- Sash downloads unmodified upstream release artifacts at install time. Never commit upstream binaries or dashboard assets to this repo, and never bundle them in the npm tarball.

## Safety Invariants

Do not weaken these without explicit user approval:

- **Never kill an unverified process.** `process.ts` verifies PID identity before any termination signal (path match on the expected executable, conservative handling of `unknown`). If you extend process management, preserve the fail-closed behavior.
- **Loopback never goes through a proxy.** External-controller requests must use the direct dispatcher; proxy env vars apply only to remote downloads.
- **Credential hygiene.** Child processes get a scrubbed environment (no `GITHUB_TOKEN`, `NPM_TOKEN`, npm auth config). State files and logs are written `0o600` on POSIX.
- **Atomic state changes.** All settings/state files go through `fs-atomic.ts`. Core upgrades keep the previous binary as `.bak` until the new one passes a health check; rollback on failure.
- **Download trust.** Only hosts in the `github.ts` allowlist are valid download origins. Archive extraction rejects path traversal and enforces the size cap.
- **Subscription content is untrusted input.** Parse defensively; reject documents that are not valid core-format YAML before writing config.yaml.

## Commands

- After code changes (not docs): `npm run typecheck` and `npm run lint`. Fix everything they report before committing.
- Run the full suite with `npm test` (type-checks, then `node:test` via `tsx`). If you create or modify a test file, run it and iterate until it passes.
- Never test against the user's real instance. Use an isolated data dir (`SASH_HOME=<abs path inside a temp dir>`) and non-default ports; machines running Sash may already occupy 7890/9090.
- Do not start the core with TUN enabled in tests or smoke tests.
- `npm pack --dry-run` after build changes to verify the published file set.

## UI Verification

- Playwright (`playwright` devDependency) is the screenshot tool for WebUI work; `scripts/ui-shot.mjs` covers common routes and viewports.
- Check both Chromium and Firefox for layout changes. Chromium-only verification misses Firefox-specific rendering differences (flex metrics, form controls, fonts). If a Firefox instance is not automatable, ask the user to eyeball the page instead of declaring Chromium-only results done.

## Dependency and Install Security

- Treat dependency and lockfile changes as reviewed code. Investigate what a new dependency does before adding it.
- When updating `undici`, read its changelog first; dispatcher and redirect-interceptor APIs change between majors.
- Run `npm audit --omit=dev --audit-level=moderate` before releases (also enforced by `prepublishOnly`).

## Git

- Only commit files you changed in this session. Stage explicit paths; never `git add -A` / `git add .`.
- Before committing, run `git status` and verify only your files are staged.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `git commit --no-verify`.
- Never commit unless the user asks.
- Message format: `{feat,fix,docs,chore}: <concise imperative summary>`. One concern per commit.

## Changelog & Releasing

- All notable changes go under the newest section in `CHANGELOG.md` (Keep a Changelog format). Released sections are immutable.
- Version bumps and `npm publish --access public` happen only with explicit maintainer approval. `prepublishOnly` runs audit, tests, and build; never bypass it with `--ignore-scripts` or `--force`.
- After any release, verify the tarball installs and runs: `npm install -g @astralyn/sash@<version>` in an isolated environment, then `sash --help` and a `SASH_HOME`-isolated `sash start` / `status` / `stop` cycle.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
