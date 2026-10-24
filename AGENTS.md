# Development Rules

- Read whole files before editing; do not rely on snippets. Keep `*.test.ts` beside modules with an absolute temporary `SASH_HOME`, and check UI changes in Chromium and Firefox via `scripts/ui-shot.mjs`.
- Stage explicit paths and review staged diffs; never commit credentials or machine-specific paths. Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `--no-verify`; the pre-commit hook is the check gate.
- Use Conventional Commits, add user-visible changes to `CHANGELOG.md` under `## [Unreleased]`, and follow `RELEASING.md`.
- Position Sash as a developer network toolbox; consult the upstream Core repository's `Meta` branch for code, schemas, and behavior.
