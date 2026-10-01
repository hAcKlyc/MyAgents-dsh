---
name: merge-release
description: Merge approved MyAgents-dsh changes into main and/or run the versioned GitHub Release workflow. Use for explicit merge, release preflight, tag, or publish requests; ordinary commits and PR creation do not invoke release.
---

# Merge and release MyAgents-dsh

Follow the requested scope: merge only, release only, or the complete merge-to-release flow. A merge request does not authorize a tag; a preflight request does not authorize publication. Do not create or move a remote tag or publish a Release without an explicit release request. Report the exact commit, version, CI result, and Release URL for the stages actually completed.

## Confirm the current contract

- Read `AGENTS.md`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `scripts/verify-release-tag.mjs`, `scripts/release-version.mjs`, the matching `release-notes/v<version>.md`, and the release section of `specs/tech_docs/assurance/verification-artifacts-and-handoff.md`. Treat the checked-out code and GitHub state as current truth.
- Root `package.json` owns the distribution version. The release tag is `v<version>`; the publisher reads that version's entire `release-notes/v<version>.md`, whose first line must be `# MyAgents-dsh <version>`. For a new version, create its own notes file and retain earlier files. The publisher appends the exact upstream DSH package release, pinned source commit/tree, package/source association, patched package version, patch-series digest, and patched artifact digest from the pinned baseline and verified Runtime. Do not handwrite or omit this provenance table. Synchronize the lockfile and run `generate:protocol` and `generate:profile` as specified by the maintained guide. Do not infer a version bump merely from a merge request.
- Inspect local and remote branch status, the intended PR or source branch, CI checks, existing tag, and existing Release. Preserve unrelated local changes. Do not merge unreviewed changes or reuse a published version.

## Merge

1. Ensure the proposed diff and required review are resolved. Run the applicable repository gates from `AGENTS.md`; check the PR's GitHub CI status and any required native or credentialed evidence for the claimed scope.
2. Merge the reviewed change into `main` through the repository's normal PR path. If the user requested only a merge, stop here and report the merge commit. Never commit implementation directly to `main` as a shortcut.
3. Refresh `origin/main` and use its actual commit as the release source. The version and release notes must be present on that commit before tagging.

## Release

1. Check that `v<version>` is unused on origin and no Release exists for it. A manual `release.yml` dispatch is available when explicitly requested, but the normal merge-to-release path does not run a separate branch or main preflight.
2. Once the reviewed PR and required CI pass, create the matching tag at `origin/main` and push it. The tag workflow runs all four native targets and starts `publish` only after they succeed. Native gates verify the packed Runtime and installed-process conformance without model credentials; live model campaigns are optional acceptance and must not block packaging. Never move a tag after a Release has been published.
3. Watch the tag-triggered workflow to completion. Its publisher checks all four target archive/manifest pairs, creates `manifest.json`, verifies the uploaded bytes, and publishes a nine-asset GitHub Release using the matching versioned notes file plus the generated upstream DSH provenance table. Confirm the public Release, all nine assets, and the provenance table; a pushed tag alone is not a release.
4. On failure, identify the failing job and exact cause. Do not manually assemble assets or relabel old evidence. If no Release exists and the owner keeps the version, finish or cancel the failed run, fix the cause on `main`, delete the unpublished tag, and push that tag at the new commit. The new run must rebuild all four targets. Otherwise create a new version. Never retarget a published Release.

The GitHub workflow owns automated Release publication. The local `publish:batch-3-release` script is for a verified recovery path, not a routine second publisher. Keep MyAgents client version binding separate; this repository owns its own four-platform Release and manifest.
