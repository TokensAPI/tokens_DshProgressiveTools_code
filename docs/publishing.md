# Private Registry Releases

This repository publishes `@tokensapi/dsh-progressive-tools` to
`https://npm.tokensapi.ai/`, not to `registry.npmjs.org`.

## Setup

Add the GitHub Actions repository secret `VERDACCIO_PUBLISH_TOKEN`. The token
must authenticate as `tokenscowork`. Never put it in the repository, workflow
arguments, logs, or commit messages.

The workflow uses pnpm 11.19.0, installs the locked public dependencies, runs
`pnpm run check`, and packs the verified `lib/` output before publishing. The
published version is never overwritten: the release job fails if that exact
package version already exists in the private registry.

## Release flow

`ci-and-release.yml` runs the checks on every supported Node version for any push or pull
request. Publishing is a separate job in the same workflow: it waits for all of
those checks, then runs only for a tag starting with `v`. A stable tag must
exactly match the package version, for example `v0.2.2` for `0.2.2`. Prerelease
tags are rejected.

Tags are the only release path; there is no manual trigger. To retry a failed
release, re-run the workflow for that tag from the Actions page.

For a fork, GitHub may require a one-time confirmation in the repository's
Actions page: choose the workflow and confirm `I understand my workflows, go
ahead and enable them`. API status alone is not sufficient; verify that an
actual push-triggered run appears. Fork releases are deliberately blocked and
remain check-only.
