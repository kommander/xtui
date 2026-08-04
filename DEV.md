# Developing and releasing xtooey

## Local Development

Requirements:

- Bun 1.3 or newer
- A terminal with Kitty or Sixel support for native images; other terminals use block rendering

Install dependencies and start the application:

```bash
bun install --frozen-lockfile
bun run start
```

Use `bun run dev` for automatic restart. Before committing, run:

```bash
bun test
bun run typecheck
bun run fmt:check
bun run lint
```

`bun run build` creates a standalone executable for the current platform. `bun run package:smoke` creates the real npm tarball, installs it into a clean temporary project with npm, verifies the `xtooey` bin shim, and imports the installed CLI.

## npm Release Model

xtooey publishes one stable, public npm package directly from `.github/workflows/release.yml`. Snapshot and prerelease publishing are intentionally unsupported. Run `bun run release:check` before every release; it includes all quality checks, tests, an npm pack preview, and the clean-install package smoke test.

## One-Time npm And GitHub Setup

npm Trusted Publishing can only be configured after the package exists. The first `0.1.0` publish was therefore performed interactively by a package maintainer with npm account-level two-factor authentication. These are the bootstrap steps if the package setup ever needs to be reproduced:

1. Publish the initial package interactively with npm account-level 2FA and push a plain version tag so the versioned schema URL exists. `0.1.0` and `v0.1.0` are already complete.
2. Configure the package's Trusted Publisher on npmjs.com:
   - Provider: **GitHub Actions**
   - Organization or user: `kommander`
   - Repository: `xtui`
   - Workflow filename: `release.yml`
   - Environment: `npm`
   - Allowed action: **npm publish**
3. In the npm package settings, select **Require two-factor authentication and disallow tokens** for publishing access.
4. Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` to the repository. Remove any old npm publish secrets after Trusted Publishing is configured.

The bootstrap publish is the `0.1.0` production release. Because it is published interactively rather than through OIDC, `0.1.0` will not have npm's automatic GitHub provenance attestation. Do not publish a GitHub Release for `v0.1.0`: the release workflow correctly rejects versions that already exist on npm. Stable GitHub Releases drive subsequent versions and receive automatic provenance.

## GitHub Repository Setup

Create an environment named `npm` before running the workflow. Referencing a missing environment creates it without protection rules.

Recommended environment and repository protection:

- Require a reviewer for the `npm` environment. Prevent self-review only when another maintainer can approve releases.
- Disable administrator bypass where repository policy permits.
- Restrict environment deployment to protected release tags such as `v*`.
- Add a tag ruleset protecting `v*` tags.
- Require review for `.github/workflows/**` with `CODEOWNERS`.
- Keep Actions restricted to approved actions; the release workflow pins third-party actions to immutable commit SHAs.

The publish job has only `contents: read` and `id-token: write`. npm exchanges the GitHub OIDC identity for a short-lived publishing credential. No npm token is available to the job. Trusted Publishing automatically generates npm provenance for this public package and public repository.

## Stable Release Procedure

1. Update `version` in `package.json` and the versioned schema URL in `README.md` to the same stable semantic version, then run `bun install` and `bun run schema` so `bun.lock` and `xtooey.schema.json` remain synchronized.
2. Run `bun run release:check`.
3. Commit and push the version change; wait for CI to pass on `main`.
4. Publish a non-prerelease GitHub Release whose tag is exactly `v<package.json version>`, for example `v0.1.1`.
5. Wait for the **Release npm** workflow and verify the version and provenance badge on npmjs.com.

With GitHub CLI, step 4 is:

```bash
version="$(node -p "require('./package.json').version")"
gh release create "v${version}" --target main --title "v${version}" --generate-notes
```

Approve the `npm` environment deployment when prompted. Do not run `npm publish` manually after the bootstrap release.

The workflow checks out the release tag, rejects prerelease versions, requires exact tag/manifest version equality, rejects versions already present on npm, validates the package, previews the npm tarball, and runs `npm publish` with the `latest` dist-tag.

## Requirements And References

Trusted Publishing currently requires a GitHub-hosted runner, Node `>=22.14.0`, npm `>=11.5.1`, and `id-token: write`. The workflow pins Node `24.19.0`, which includes a compatible npm release.

- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
- [npm publishing access and 2FA](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification)
- [npm `publishConfig`](https://docs.npmjs.com/cli/v12/configuring-npm/package-json#publishconfig)
- [GitHub OIDC security](https://docs.github.com/en/actions/reference/security/oidc)
- [GitHub environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [GitHub release events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)
- [GitHub Actions hardening](https://docs.github.com/en/actions/reference/security/secure-use)
- [OpenTUI production release orchestration](https://github.com/anomalyco/opentui/blob/main/.github/workflows/release.yml)

OpenTUI's useful tag/version validation was retained conceptually. Its monorepo artifact handoff, native package fan-out, snapshots, signing, reusable workflows, and long-lived npm token are unnecessary for this single Bun CLI and were deliberately omitted. If npm classifies the package under its [dual-use policy](https://docs.npmjs.com/policies/dual-use), direct publishing must be replaced with npm's staged approval flow.
