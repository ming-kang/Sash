# Development Rules

## Design

- Keep each responsibility in one place and reuse existing state. Add machinery only for a concrete need; inline helpers with a single call site. Ask before removing deliberate functionality.
- `src/daemon/` is the sole application writer; CLI and dashboard use its API. `src/commands/` wires commands only.
- Settings are validated once in `settings.ts`; typed daemon responses are trusted, not re-validated. Local records are read leniently: unknown fields pass, unreadable records count as absent or stale.
- Strict TypeScript ESM, Node >= 24, no `any`. `dist/` is generated; never edit it. `src/cli.ts` lazy-loads commands with `await import(...)`; keep imports elsewhere static.
- Check `node_modules` for an external API's types instead of guessing; upgrade an outdated dependency rather than downgrading code to satisfy its types.

## Safety

Do not weaken these boundaries without explicit user approval.

- **Processes:** verify a PID's executable path before every termination; unknown identity never authorizes a signal.
- **Transport:** loopback/controller requests use the direct dispatcher. Proxy environment variables apply only to remote downloads.
- **Credentials:** child environments are scrubbed of npm auth config and unrelated tokens; only `sashd` receives `GITHUB_TOKEN`/`GH_TOKEN`. Never log secrets. State and logs are POSIX `0600`; log appends never follow symlinks.
- **Persistence:** state writes use `fs-atomic.ts`.
- **Downloads:** origins are allowlisted in `github.ts`; archives verify against the release API's SHA-256 while streaming; extraction rejects path traversal and caps size. A loopback proxy refusal may fail open to one warned direct retry for these allowlisted downloads only — user-supplied URLs such as subscriptions always fail closed. The only unsigned fetch is Core's own geodata download (Core cannot use a proxy it has not started); it never applies to verified downloads.
- **Self-upgrade:** npm owns package integrity — run its global install for one exact version while Sash keeps serving the proxy.
- **Subscriptions:** parse untrusted YAML once and reject non-object documents; deeper acceptance is Core's pre-flight job.

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

- Booleans read `on`/`off`; known absence reads `not installed`, `off` or `none`; `unknown` means observation failed and includes the reason. Errors explain what happened and what to do. PIDs stay out of prose (they belong in `--json`).
- JSON fields and values, `doctor --json` check ids and exit meanings (0 success, 1 failure, 2 incomplete observation) are frozen APIs; copy changes must preserve them.
- Be short and direct; no filler or emojis. Answer questions before commands or edits; state agreement or disagreement before responding to feedback.

## Workflow

- Read whole files before editing code you have not inspected; do not rely on search snippets.
- After code changes: `npm run typecheck`, `npm run lint`, then affected tests once (`npm test -- doctor.test.ts` filters); a test you created or modified must pass before moving on. Build/packaging changes also run `npm run smoke:package`; UI changes also run Chromium and Firefox checks with `scripts/ui-shot.mjs` (if Firefox cannot be automated, ask the user to inspect it).
- Tests live beside modules as `*.test.ts` and use an absolute temporary `SASH_HOME`, non-default ports and no TUN — never the user's instance. Regression tests for a GitHub issue carry a comment with the issue number.
- Understand a dependency before adding it and review lockfile diffs — runtime dependencies are bundled into `dist`. Install with `--ignore-scripts`; run lifecycle scripts only when asked. Read `undici`'s changelog before upgrading it.

## Git

Other agent sessions may work in this tree at the same time; never touch files outside your own changes.

- Do not commit unless asked. Run `git status` first and stage only explicit paths you changed in this session.
- Message format: `{feat,fix,docs,chore}: <imperative summary>`, one concern per commit.
- Never use `git add -A`, `git add .`, `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash` or `git commit --no-verify`. Never force push.
- Resolve rebase conflicts only in files you changed; if a conflict lands elsewhere, abort and ask the user.

## Changelog and Releasing

- Put notable changes in the newest `CHANGELOG.md` section. Append to existing subsections; released sections are immutable.
- Follow `RELEASING.md`: version bumps and workflow dispatches need maintainer approval. Publish through `.github/workflows/publish.yml` with OIDC; no npm publishing secrets or bypassing `prepublishOnly`.

## Upstream

- Position Sash as a network toolbox for developers, learning and research. Never use "mihomo" in package/bin names, data folders or user-visible identifiers. Upstream names belong only in README attribution; code, logs and internal docs may name them factually.
- Never commit or bundle upstream binaries or dashboard assets; download unmodified release artifacts at install time.
- Consult the upstream Core repository's `Meta` branch for code, schemas and behavior; `main` is unrelated. Releases are branch-independent.
