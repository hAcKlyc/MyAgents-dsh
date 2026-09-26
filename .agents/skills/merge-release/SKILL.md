---
name: merge-release
description: Merge approved MyAgents-dsh changes into main and/or run the versioned GitHub Release workflow. Use for explicit merge, release preflight, tag, or publish requests; ordinary commits and PR creation do not invoke release.
---

# Merge and release MyAgents-dsh

Follow the requested scope: merge only, release only, or the complete merge-to-release flow. A merge request does not authorize a tag; a preflight request does not authorize publication. Do not create or move a remote tag or publish a Release without an explicit release request. Report the exact commit, version, CI result, and Release URL for the stages actually completed.

## Confirm the current contract

- Read `AGENTS.md`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `scripts/verify-release-tag.mjs`, `scripts/release-version.mjs`, the matching `release-notes/v<version>.md`, and the release section of `specs/tech_docs/assurance/verification-artifacts-and-handoff.md`. Treat the checked-out code and GitHub state as current truth.
- Root `package.json` owns the distribution version. The release tag is `v<version>`; the publisher reads that version's entire `release-notes/v<version>.md`, whose first line must be `# MyAgents-dsh <version>`. For a new version, create its own notes file and retain earlier files. Synchronize the lockfile and run `generate:protocol` and `generate:profile` as specified by the maintained guide. Do not infer a version bump merely from a merge request.
- Inspect local and remote branch status, the intended PR or source branch, CI checks, existing tag, and existing Release. Preserve unrelated local changes. Do not merge unreviewed changes or reuse a published version.

## Merge

1. Ensure the proposed diff and required review are resolved. Run the applicable repository gates from `AGENTS.md`; check the PR's GitHub CI status and any required native or credentialed evidence for the claimed scope.
2. Merge the reviewed change into `main` through the repository's normal PR path. If the user requested only a merge, stop here and report the merge commit. Never commit implementation directly to `main` as a shortcut.
3. Refresh `origin/main` and use its actual commit as the release source. The version and release notes must be present on that commit before tagging.

## Release

1. Check that `v<version>` is unused on origin and no Release exists for it. Run the `release.yml` manual dispatch on `main` as a four-platform preflight and wait for its result. Manual dispatch builds and verifies artifacts but does **not** publish a Release.
2. If preflight is green and publication was requested, create the matching tag at the verified `origin/main` commit and push it once. Never force-push, delete, or retarget a published tag. A tag push starts the four native target jobs and, after they succeed, the `publish` job.
3. Watch the tag-triggered workflow to completion. Its publisher checks all four target archive/manifest pairs, creates `manifest.json`, verifies the uploaded bytes, and publishes a nine-asset GitHub Release using the matching versioned notes file. Confirm the public Release and its asset set; do not equate a pushed tag or a successful preflight with a completed publication.
4. On failure, identify the failing job and exact cause. Do not manually assemble assets, relabel old evidence, or retry by moving the tag. If publication is incomplete, report the state and the next safe recovery step from the workflow and publisher script.

The GitHub workflow owns automated Release publication. The local `publish:batch-3-release` script is for a verified recovery path, not a routine second publisher. Keep MyAgents client version binding separate; this repository owns its own four-platform Release and manifest.
