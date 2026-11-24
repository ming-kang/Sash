# Releasing Sash

A release is two artifacts built from one `main` commit by one CI run:

| Artifact | Built by | Published to |
| :-: | :-: | :-: |
| `npm-package` | CI `build` job (Linux) | npm, by the **Publish npm** workflow |
| `tun-helper` | CI `tun-helper` job (Windows) | the GitHub Release `vX.Y.Z`, by the same workflow |

The npm package contains no executables. Core is downloaded at runtime from `MetaCubeX/mihomo`; the Windows TUN helper is downloaded from Sash's own GitHub Release when a user installs it (see [TUN Mode](./docs/backend.md#tun-mode)). Nothing is rebuilt during publication: the workflow publishes exactly what CI built and tested.

## Checklist

1. Bump `package.json` and `package-lock.json` together:

   ```bash
   npm version x.y.z --no-git-tag-version
   ```

2. Move the notes from `## [Unreleased]` into `## [x.y.z] - YYYY-MM-DD` and leave an empty `## [Unreleased]` on top.
3. Run the checks relevant to the change (`npm run typecheck`, `npm run lint`, affected tests; `go test ./...` in `helper/` for helper changes).
4. Commit, push to `main` and wait for CI to pass. CI runs the static checks and the production audit, packs the tarball once, runs the tests and package smoke checks on Windows, Linux and macOS against that tarball, and tests and builds the TUN helper on Windows. Both artifacts are kept for 14 days.
5. Dispatch **Publish npm** from `main`:

   ```bash
   gh workflow run publish.yml --repo ming-kang/Sash --ref main -f version="x.y.z"
   gh run watch --repo ming-kang/Sash --exit-status
   ```

The workflow checks that the version matches `package.json`, `package-lock.json` and exactly one `CHANGELOG.md` heading, finds the successful CI run for the commit, and requires both artifacts from it. It then publishes the tarball with provenance, tags the commit `vx.y.z`, and creates the GitHub Release from the changelog section with the two helper executables attached. GitHub records each asset's SHA-256 digest, which is what Sash verifies when it downloads the helper. A missing or expired artifact stops the run before anything is published; rerun CI to recreate it.

Local `npm publish` is blocked and prints the workflow instruction.

## npm Trusted Publishing

Publication uses npm Trusted Publishing (OIDC). The repository holds no `NPM_TOKEN`, `NODE_AUTH_TOKEN` or other npm secret. On npmjs.com (package Settings → Trusted Publisher), the connection is:

- Provider: GitHub Actions
- Owner `ming-kang`, repository `Sash`, workflow `publish.yml`, environment empty
- Direct `npm publish` allowed

Fields are case-sensitive and a connection cannot be edited; delete and recreate it to change one. npm may accept an upload before the version is publicly visible.

## Failed publication

- **Before `npm publish`:** fix the cause and dispatch the workflow again.
- **`npm publish` failed:** read the error before retrying. npm versions are immutable, and a processing notice or a version not yet visible does not justify another upload.
- **Only the tag or the Release failed:** rerun the failed **Tag and create the GitHub Release** job in the same run. It reuses that run's commit and CI artifacts; creating the tag and the Release, and uploading the helper, are idempotent. Do not dispatch the workflow again or rerun its publish job.
- **The helper artifact expired before the Release job was rerun:** rerun the `tun-helper` job of the original CI run, then rerun the Release job.
- **A published version is defective:** deprecate it on npm and release the next patch.
