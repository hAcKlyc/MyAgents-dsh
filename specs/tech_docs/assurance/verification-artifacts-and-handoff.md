---
type: technical-architecture
status: implemented-runtime-delivery
module: verification-artifacts-and-handoff
updated: 2026-10-01
---

# Verification, artifacts, and integration handoff

## 1. Purpose and authority

The release system turns exact source, dependencies, DSH patches, generated contracts, Runtime bytes, platform evidence, and compatibility claims into independently verifiable immutable deliveries. A passing source checkout is not itself a Runtime artifact, and an artifact for old bytes cannot authorize new bytes.

Local development and tests accept Node `>=24.15.0 <25` with the pinned npm version. Artifact builders still require exact Node `24.20.0`, matching the current bundled Runtime and recorded build provenance. Separate policy checks enforce these scopes so a developer can run tests on 24.15 without accidentally creating a Runtime artifact that claims 24.20 bytes.

## 2. Relationships

- **Owns:** content-addressed build/verification chain, clean-input policy, artifact inventories, evidence binding, immutable integration handoff and transfer verification.
- **Depends on:** pinned source/lock/toolchain, adjudicated DSH patches, generated protocol/profile/contracts, platform and compatibility evidence.
- **Consumed by:** Runtime execution, MyAgents ingestion, Reference Web packaging, release acceptance and downstream independent verification.
- **Does not own:** implementation behavior, compatibility promotion, source-control cleanliness policy outside a build, signing/notarization credentials or product acceptance.

## 3. Evidence chain

```text
pinned DSH source + ordered patches + exact stores/toolchain
  -> patched DSH artifact
  -> official Runtime artifact
  -> native/platform evidence
  -> compatibility manifest
  -> Batch 3 integration handoff
```

The patched DSH artifact, Runtime inventory, platform evidence filenames and outer handoff are
content-addressed, but verifier strength differs by layer. The nested Runtime verifier rejects
unexpected/special files, multi-link regular files and mode/content drift. During
Runtime staging, contained npm symlinks are materialized as regular files; dangling, directory,
escaping or unstable links fail closed. The outer handoff hashes every inventoried file and delegates
the Runtime subtree to that verifier. Neither the Runtime nor outer verifier invokes the generic
forbidden-content scanner; repository/workspace-pack release gates provide that separate check. The
outer verifier also does not reject outer hardlinks or semantically validate every copied
contract/evidence document.
POSIX runners verify exact directory and file mode bits. Windows does not report POSIX executable
bits, so its Runtime inventory records a stable logical regular-file mode and still verifies file
type, identity and bytes; the Reference Web inventory reserves logical executable mode for its
declared POSIX launcher.

The Runtime builder prunes the installed delivery staging tree through
`scripts/runtime-artifact-packaging.ts` after npm tree validation/link materialization and before
creating the content manifest. It removes source maps, TypeScript declarations, PDB debug symbols,
package-root test/example/CI resources, and node-pty prebuilds for other platforms/architectures.
The OpenAI and Anthropic SDKs retain compiled runtime exports but omit their duplicate TypeScript
source directories. Other source directories remain, including packages exposing TS runtime subpaths.
Test Host and fake-model testkit packages are built for conformance but are not installed as production
Runtime dependencies. Runtime entrypoints, self-check and their production dependency graph remain.
Non-Windows targets also omit node-pty's Windows third-party assets. Target native addons and
executable helpers, JavaScript modules, PDF workers/fonts/character maps/WASM, package manifests
and licenses remain. Nested implementation directories named `test` or `examples` are not treated
as package-root development resources. The helper reports removed file/byte totals and is idempotent.

This projection belongs to the distribution producer, not MyAgents ingestion. It does not modify
the source checkout, npm cache, accepted patched DSH tarballs, or an already sealed handoff. Both
local Dev and Release use this builder and run installed Runtime process conformance against the
pruned bytes. SDK development/type assets remain in their source packages; the executable Runtime
delivery is not a TypeScript development dependency.

New Runtime artifacts, Reference Web artifacts and Batch 3 handoffs carry the repository's
Apache-2.0 `LICENSE` alongside their MyAgents-dsh code. Patched DSH packages retain their MIT
licenses; the handoff also includes its existing third-party dependency and obligation inventory.

Three current chain gaps must not be hidden by the diagram:

- the Runtime builder records `repositoryHead` and hashes selected working-tree inputs but does not
  require the worktree to be clean; a Runtime built from dirty bytes can later match a restored clean
  `HEAD` unless its input digests are independently compared;
- pending platform evidence is not required to bind the current Runtime manifest, and the verifier's
  permissive condition can accept a minimal self-declared or `outcome: passed` JSON;
- third-party notices are derived from the pinned DSH baseline, not the complete final Runtime
  dependency closure, and outer verification checks their bytes/existence rather than license
  completeness.

These are implementation gaps. Until strengthened, release acceptance must preserve official
builder provenance plus external review/security evidence rather than claim the outer verifier alone
proves the entire chain.

## 4. Verification layers

Verification is deliberately layered:

| Layer | What it proves |
| --- | --- |
| unit/type/lint/build | Source-level invariants and deterministic projections under fakes |
| contract/conformance | Strict protocol, profile, tool and Host fixture behavior |
| packed artifact | The installed Runtime inventory, public imports, self-check and process behavior of exact bytes |
| native/platform | OS-specific process, path, SQLite, packaging and cleanup behavior |
| live/dynamic/soak | Real Provider/Host workflow and long-lifecycle behavior for an exact artifact/cell |
| handoff verification | With an expected digest, the transferred outer inventory matches the trusted identity and the verifier's explicitly checked nested semantics |

`packages/dynamic-e2e` is test-only. Fresh external Tester Agents operate its CLI and evaluate observable scenarios; the packed DSH Root Agent is the system under test. Test rubrics, expected tool order and credential fixtures are never installed into the Runtime artifact.

The handoff ships the named platform JSON evidence. Pre-artifact reports, full dynamic/soak
campaigns, independent reviews and signing/notarization evidence remain in trusted
out-of-band release records unless explicitly added to a future manifest. The outer digest cannot
prove evidence it does not inventory.

## 5. Code and builder ownership

| Concern | Authority |
| --- | --- |
| Runtime/artifact inventory and self-check | `packages/artifact-verifier/src/runtime-artifact.ts`, `self-check.ts` |
| Compatibility declaration | `integration-compatibility.ts` |
| Batch 3 outer handoff and generated README | `integration-handoff.ts` |
| DSH artifact construction | `scripts/build-patched-dsh-artifact.ts` |
| Runtime composition verification and artifact construction | `scripts/verify-dsh-runtime-composition.ts` |
| Native campaign | `scripts/run-batch-1-native-campaign.ts` |
| Batch 3 handoff | `scripts/build-batch-3-integration-handoff.ts` |
| GitHub Release target archive and full-set publication | `scripts/package-batch-3-release.mjs`, `scripts/publish-batch-3-release.mjs` |

The developer setup and one-target local handoff path is described in [Development setup and local integration](./development-and-local-integration.md). `scripts/build-native-handoff.mjs` builds the Runtime and handoff for both paths. Local Dev records a pending native-validation claim without a model key; the tag-driven `release:target` runs a credentialed native campaign, records `verified`, and creates a Release archive/companion pair.

After changing the root version and matching npm lock metadata, build the patched DSH artifact from the pinned source with the exact artifact toolchain. The artifact manifest includes the root package and lock hashes, so record its newly generated manifest and `SHA256SUMS` digests in `accepted-patched-dsh-artifact-v1.json` after verifying that its DSH package inventory and content digests still match the accepted source. Then run `generate:protocol` to refresh its typed Runtime version, protocol fixtures and schema, followed by `generate:profile` for the dependent profile. These generated projections must not be edited by hand. A stale accepted digest will reject the release before Runtime composition starts.

The root `package.json` `version` is the single MyAgents-dsh distribution version. Release commands derive `v<version>` from it; an explicit `--tag` must match. Workspace package `0.0.0` versions and the pinned upstream DSH engine version are separate identities. The release packager accepts one clean-commit official handoff, trusted outer digest and target. It requires a single `verified` native target claim and that target's native addon, verifies the source and an extracted copy, then emits `myagents-dsh-<tag>-<target>.tar.gz` plus companion JSON. The publisher validates all four pairs from one source, creates `manifest.json`, uploads nine assets as a draft Release, downloads and compares the remote bytes, then makes the Release public. Without `--publish` it only prints the producer-owned manifest. Existing checked-in handoffs have pending claims and cannot be used as release input.

Runtime composition prefers the npm cache for its dynamic consumer and final Runtime installs but permits fetching missing transitive packages. The patched source, package versions, installed tree, Runtime artifact and final handoff are still verified. The CLI logs only digests of its large verification results so GitHub Actions can process subsequent steps without multi-megabyte log lines. On GitHub-hosted runners, the large temporary composition tree is left to the ephemeral runner teardown after the verified artifact is promoted; local runs remove it before exit.

Release notes are one file per version: `release-notes/v<version>.md`, selected from the root package version. Its first line must be `# MyAgents-dsh <version>`. The tag workflow fails if the selected file is missing or has a mismatched heading. The publisher uses the complete file as the narrative and automatically appends an **Upstream DeepSeek Harness** table to the GitHub Release body. That table names the exact MyAgents-dsh commit, upstream DSH package release, pinned source commit/tree, recorded package/source association, MyAgents patched DSH package version, patch-series SHA-256, and patched artifact manifest SHA-256. The upstream package and source identities come from `specs/dsh/dsh-baseline-v1.json`; the patched package identity comes from the verified Runtime inside the release asset. The package/source association is currently `unproven` and must not be implied by their matching version labels. Every published Release must show these facts. A new version gets a new file, while prior versions' notes remain in the repository. No Markdown section extraction or accumulated notes file is involved.

The `.github/workflows/release.yml` runs the same builders on macOS ARM, macOS Intel, Linux x64 and Windows x64. Its native jobs set one explicit `COREPACK_HOME` for pnpm priming and patched-source artifact construction, including on Windows where Corepack's default cache location differs. After PR review and CI, the normal path merges to `main` and pushes the matching tag directly; the tag workflow performs the four-platform gate and publishes only when all targets pass. `workflow_dispatch` remains an optional four-platform diagnostic run and does not publish. The credentialed native campaign reads the checked-in approved route files and requires one repository Secret, `DSH_RELEASE_PROVIDER_KEY`. Missing credentials fail the native job. Published Release tags and assets are immutable; the body may be edited to correct metadata without moving the tag or replacing assets. CI does not create the tag. If a tag run fails before any Release is published, the owner may keep that version by finishing or canceling the failed workflow, fixing the cause on `main`, deleting the unpublished remote tag, and pushing it again at the new commit. Check that no Release exists before doing so; the new run must rebuild all four targets. Existing DSH Session `snapshotEvents` / `eventAt` reads use the upstream grandfathering allowance: `specs/lint/existing-deprecated-session-reads.json` records each exact lint diagnostic and its maximum count. `npm run lint` rejects new diagnostics or additional uses; migration can remove entries as those reads are replaced. Release status belongs to GitHub Release and its exact native/artifact evidence, not this guide.

After those gates pass and the version tag points at the accepted clean commit, package each target with:

```bash
npm run package:batch-3-release -- \
  --handoff /absolute/path/to/official-handoff \
  --handoff-sha256 <TRUSTED_OUTER_SHA256> \
  --target darwin-arm64 \
  --out /absolute/path/to/empty-release-output \
  --node /absolute/path/to/node-24.20.0
```

The other supported target values are `darwin-x64`, `linux-x64` and `win32-x64`. Their archives must come from target-specific native campaigns and be packaged on those targets. In particular, Intel macOS needs an x64 Node process and x64 native dependencies; the arm64 handoff cannot be renamed. MyAgents selects only a version and reads this repository's `manifest.json` at `https://github.com/hAcKlyc/MyAgents-dsh/releases/download/<tag>/manifest.json`.

For recovery after a verified native campaign, place all eight target files in one external directory and run `npm run publish:batch-3-release -- --dir /absolute/path/to/release-set` to validate and print the DSH Release manifest. `--publish` performs draft upload, remote byte checks and publication; the remote tag must already identify the current commit. Normal publication is owned by the tag workflow. The command refuses a partial target set and does not create a tag.

The official builder nests the complete Runtime artifact and verifier, its selected generated
protocol/client/tool/profile contracts, compatibility manifest, platform evidence, notices, an outer
verifier and generated README. The outer verifier semantically checks the nested Runtime,
compatibility/client, selected platform fields and notices presence/hash; other copied contracts are
protected by outer inventory but are not all required or cross-compared semantically by the generic
verifier. The official builder's fixed copy list is therefore part of the accepted process.

## 6. Platform claims

For a `verified` claim, the current verifier requires a passing report that names the exact Runtime
manifest. A complete adapter whose native campaign has not run is labeled
`implementation-complete_pending-native-validation`, but current pending evidence is not strongly
Runtime-bound or schema-validated. It is a limitation label, not proof of a native campaign.
MyAgents may advertise only claims accepted by the release authority beyond these structural checks.

## Toolchain identity

Development and tests accept Node `>=24.15.0 <25` with npm `11.19.0`. Artifact builders and the official Runtime distribution require exact Node `24.20.0` and npm `11.19.0`; CI, launchers, protocol fixtures and Runtime self-check enforce the applicable identity. Rebuilding the fixed DSH source and patch series under a different toolchain changes build provenance and the resulting artifact digest.

Source validation must consume the accepted patched DSH packages through the package installer; an untouched registry install does not contain the session-projection and other public-seam patches used by this Runtime. The accepted artifact manifest and offline consumer lock provide those package bytes; never edit installed package source to emulate the patches.

On a clean CI or release runner, first prime the package store from the exact historical DSH source commit through its frozen lockfile, then build and verify the patched DSH artifact. Run source validation in CI or locally before tagging. Native Release packaging does not repeat the repository suite on each of the four targets; it verifies the artifact, Runtime composition, and each target's native campaign. Foundation CI also runs the installed Runtime composition against the pinned pi-ai source, so model-visible tool and background-work sequencing fail before a release preflight. Its background Job fixture requires both real completion notices to reach a model request; depending on runner timing, they can join the ordinary tool-result step or require a later step. `scripts/prime-historical-dsh-store.ts` owns that temporary worktree, primes the same platform-selected optional dependencies as the offline artifact install plus exact external npm metadata, and removes the worktree after priming. The artifact builder and source compiler then use the primed stores offline. CI and release runners prime only pi-ai's selected npm workspace with install scripts disabled; the verifier builds and tests that exact source in its own isolated worktree. The isolated pi-ai install prefers the cache and fetches missing lockfile-pinned packages, since the first workspace install does not guarantee every optional peer tarball is cached. This avoids unrelated `canvas` native builds during Intel dependency preparation. `npm run install:verified-dsh-checks -- --artifact <directory>` installs the artifact's verified package tarballs through npm for those checks and temporarily points every workspace DSH resolution at those tarballs, preventing nested registry copies. It restores the checkout's `package.json` byte-for-byte after npm resolves the local tarballs and leaves `package-lock.json` unchanged; the release gate then checks the clean repository. The patched DSH source test uses a narrow set of pinned workspace dependencies so it does not fetch unrelated document engines. The release scripts launch npm, pnpm, and Corepack through the selected Node's JavaScript entrypoints, including on Windows where their shell shims cannot be started as ordinary executables.

The one-shot composition fixture exits after its evidence is flushed and its asserted Runtime/Host cleanup completes; unrelated retained timers do not extend this artifact gate. The composition CLI also writes final evidence synchronously and exits after the verified Runtime has been promoted, because imported product modules can retain timers even after the CLI's synchronous work finishes. The process-conformance runner has a five-minute bound and reports the active scenario if it fails. The Runtime candidate is fully verified before an atomic same-volume rename into the requested output; the unchanged renamed bytes are not rescanned a second time.

Patch files are checked out with LF bytes on every platform. The exact DSH and pi-ai patch builders also force LF when creating temporary source worktrees, so Windows Git's `core.autocrlf` setting cannot change patch matching or the sealed source bytes. The DSH artifact builder uses a short source worktree under `RUNNER_TEMP` on Windows to keep pnpm's deep workspace paths within Windows file-system limits; Git worktree cleanup enables `core.longpaths` within the isolated build environment. Tar member listings accept both LF and CRLF emitted by native `tar`, while the canonical archive bytes remain identical across platforms.
The isolated DSH artifact builder enables Git long paths as well, including for temporary worktree removal; cleanup errors must not hide an earlier build failure.
The pi-ai source gate extracts only its model-data directory from the integrity-pinned registry tarball before building the pinned source; it does not resolve the registry package's separate transitive dependencies.

The subsequent Runtime/native/handoff receipts belong to the Host lock and trusted external release record. Windows/Linux remain pending native validation until campaigns run on those platforms.

## 7. Rebuild and update rule

Any change that alters sealed Runtime authority, evidence bytes or outer output produces a new
identity. The Batch 3 builder script itself is not recorded as an outer builder-authority input, so a
semantic builder change that happens to emit identical bytes does not independently change the
digest. Add an outer builder-authority digest if builder provenance itself must become identity.
Official DSH refreshes must adjudicate every seam as retire/reduce/rebase before rebuilding the full
chain. Accepted handoffs are never edited in place.

The Batch 3 builder checks a clean checkout at startup, requires a Runtime artifact whose recorded
`repositoryHead` equals current `HEAD`, one exact four-platform claim file and content-addressed
evidence filenames. It does not re-check clean/HEAD at the end and does not compare every Runtime
input digest with the checkout, so concurrent changes or a previously dirty Runtime build remain a
gap. It regenerates/inventories the README, seals and self-verifies the directory, and prints the
outer digest.

## 8. Security boundary

Release policy forbids credentials, private prompts, transcripts, user files, Workspace content,
attachment bytes and local Runtime homes. Repository/workspace-pack scanners and the Reference Web
artifact scanner enforce their defined inputs; Runtime and outer handoff inventory verification do
not scan arbitrary Runtime/platform-evidence/notices content, so the security gate remains required.
Notices do not yet prove the full Runtime production closure.
Temporary paths and caches are never release authority.

## 9. Architecture-correct maintenance path

1. Read this module guide, the whole-system Architecture and the applicable build scripts.
2. Run the repository gates under the exact toolchain.
3. Prove the checkout clean both before and after Runtime construction, and retain/compare its input
   digests; build into a new external directory.
4. Run the required deterministic, native, dynamic, security, and platform campaigns.
5. Generate a new handoff; never copy selected files into an old one.
6. Verify a transferred clean-directory copy while supplying the trusted outer digest. The current
   `verify.mjs` argument is optional, so callers must treat a missing expected digest as unauthenticated
   internal-consistency checking, not release identity verification.
7. Record acceptance against the exact artifact and release identity only after its evidence is accepted.

Before stronger self-contained claims, make all platform evidence Runtime-bound/schema-checked,
add Runtime and Batch 3 end-of-window cleanliness checks, derive notices from the final dependency
closure, scan the outer inventory, require the expected digest, and cross-check copied
profile/protocol identities. Exact signing and notarization belong to the consuming release
pipeline. Local unsigned development acceptance may prove functionality but cannot be relabeled as
signed distribution evidence.

The pre-artifact campaign accepts `--dsh-source /absolute/path/to/official-checkout` when the optional sibling checkout lacks the pinned upstream object. It runs the same source/blob/compile verification on that exact checkout and records the commands; it does not mutate or replace the sibling checkout.

## Host startup verification

The official handoff verifier returns its already verified nested Runtime together with a self-check report derived from that inventory and the executing Node/platform. MyAgents performs this combined scan once per Sidecar installation identity, then retains the existing actual-process initialize/status handshake. It no longer starts a second full Runtime self-check scan or a separate Node version subprocess. Standalone `--self-check` remains available. This reuses one verification result rather than adding a cache with a new trust model. The public standalone protocol contract is an inventoried handoff output generated by the official builder.


Runtime construction resolves the pi-ai package/version from the fixed pi-ai seam source authority, and compatibility generation declares 0.87.1. A regression ties that declaration back to the fixed source to catch drift that adapter-only tests cannot reach. Current-byte Runtime/native/Host evidence remains required before acceptance.
