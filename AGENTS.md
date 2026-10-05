# Development Rules

## Workflow

- Read whole files before editing code you have not inspected; do not rely on search snippets.
- UI changes run Chromium and Firefox checks with `scripts/ui-shot.mjs`.
- Tests live beside modules as `*.test.ts` and use an absolute temporary `SASH_HOME`.

## Git and release

- Stage explicit paths and review the staged diff; never commit credentials or machine-specific paths.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `--no-verify`; the pre-commit hook is the check gate.
- Use Conventional Commits: `<type>[(scope)]: <summary>`.
- Add user-visible changes to `CHANGELOG.md` under `## [Unreleased]`.
- Follow `RELEASING.md`.

## Upstream

- Position Sash as a network toolbox for developers.
- Consult the upstream Core repository's `Meta` branch for code, schemas and behavior.
