# Releasing Sash

Stable releases are published from `.github/workflows/publish.yml` with npm Trusted Publishing (OIDC). The repository must not contain `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or another npm publishing secret.

## npm Trusted Publisher

The npm package uses this one-time configuration on npmjs.com (package Settings → Trusted Publisher):

- Provider: GitHub Actions
- GitHub owner: `ming-kang`
- Repository: `Sash`
- Workflow filename: `publish.yml`
- Environment: empty
- Allowed actions: `npm publish` permitted (direct publishing)

All fields are case-sensitive and a connection cannot be edited after creation; delete and recreate it to change any field. With direct publishing allowed, one dispatch publishes immediately. If the connection is ever recreated without direct publishing (stage-only), the first dispatch only stages the release: approve it on npmjs.com, then dispatch the same workflow again — it detects the published version and resumes with provenance and registry-install verification instead of failing.

## Release checklist

1. Update `package.json` and `package-lock.json` together:

   ```bash
   npm version x.y.z --no-git-tag-version
   ```

2. Move the release notes out of `## [Unreleased]` into `## [x.y.z] - YYYY-MM-DD` and keep an empty `[Unreleased]` section on top.
3. Run the normal checks:

   ```bash
   npm ci
   npm run audit:prod
   npm run lint
   npm test
   npm run build
   npm run smoke:package
   ```

4. Commit and push the release change to `main`, then wait for CI to pass.
5. Dispatch **Publish npm** from `main` with the same version:

   ```bash
   gh workflow run publish.yml --repo ming-kang/Sash --ref main -f version="x.y.z"
   gh run watch --repo ming-kang/Sash --exit-status
   ```

   The workflow completes the whole release: it verifies the release request, runs the full gate (audit, lint, tests, build), packs and smoke-tests the tarball, publishes it with provenance, verifies the published provenance and registry installation, runs a Windows runtime smoke against the registry package with a real Core (`scripts/registry-runtime-smoke.mjs`), then tags the release commit as `vx.y.z` and creates the GitHub Release from the version's `CHANGELOG.md` section. When the run is green, the release is finished.
6. Optionally spot-check the result:

   ```bash
   npm view @astralyn/sash version dist-tags --json
   node scripts/registry-runtime-smoke.mjs x.y.z
   ```

   The npm package page should show provenance from `.github/workflows/publish.yml` at the tagged commit. Core downloads use public release metadata; credentials from the login shell are deliberately scrubbed from the daemon environment.

## Failed publication

First check `npm view @astralyn/sash@x.y.z version`. If the version does not exist, fix the release commit and dispatch the workflow again. If it exists, npm has already accepted the immutable package; do not unpublish or try to overwrite it. Dispatching the workflow again resumes instead of republishing: it verifies the existing package's provenance (which must identify a commit on `main`), re-runs registry verification and the runtime smoke, then finishes the tag and GitHub Release. Tagging and Release creation are idempotent, so a rerun after partial finalization is safe. If the published package is defective, deprecate it and prepare the next patch version.
