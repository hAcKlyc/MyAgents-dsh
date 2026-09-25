---
type: technical-architecture
status: implemented-runtime-delivery
module: verification-artifacts-and-handoff
updated: 2026-09-02
product_scope:
  - ../../prd/prd_0.1_agent_runtime.md
  - ../../prd/prd_0.3_myagents_integration.md
implementation_decisions:
  - ../../prd/tech_rfc_0.1_verification_release.md
  - ../../prd/tech_rfc_0.3_myagents_dsh_integration.md
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
campaigns, independent reviews and signing/notarization evidence remain in PRD ledgers or trusted
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
| GitHub Release target archive and full-set publication | `scripts/package-batch-3-release.mjs`, `scripts/publish-batch-3-release.mjs`; [Release delivery PRD](../../prd/prd_0.3_release_delivery.md) and [RFC](../../prd/tech_rfc_0.3_release_delivery.md) |

The release packager accepts one clean-commit official handoff, trusted outer digest and target. It requires a `verified` claim and that target's native addon, verifies the source and an extracted copy, then emits `myagents-dsh-<tag>-<target>.tar.gz` plus exact archive/Runtime/compatibility metadata. The separate publisher validates all four target pairs from one source before a single GitHub Release creation; its default mode only prints the exact MyAgents lock entry, while `--publish` performs the external action. The current handoff claims remain pending, so packaging them as public target assets is blocked. A tag-triggered workflow must wait for the existing full assurance and native gates; the current foundation CI alone is not a release workflow.

After those gates pass and the version tag points at the accepted clean commit, package each target with:

```bash
npm run package:batch-3-release -- \
  --handoff /absolute/path/to/official-handoff \
  --handoff-sha256 <TRUSTED_OUTER_SHA256> \
  --tag vX.Y.Z --target darwin-arm64 \
  --out /absolute/path/to/empty-release-output \
  --node /absolute/path/to/node-24.20.0
```

The other supported target values are `darwin-x64`, `linux-x64` and `win32-x64`. Their archives must come from target-specific native campaigns and be packaged on those targets. In particular, Intel macOS needs an x64 Node process and x64 native dependencies; the arm64 handoff cannot be renamed. Publish the four archives and companion JSON files only after review; then copy each archive digest and size into the MyAgents release lock. The fixed download URL is `https://github.com/hAcKlyc/MyAgents-dsh/releases/download/<tag>/<asset-name>`.

After placing all eight files in one external directory, run `npm run publish:batch-3-release -- --tag vX.Y.Z --dir /absolute/path/to/release-set` to validate and print the MyAgents `release` lock entry. Once the release gates and review pass, repeat with `--publish`; the remote tag must already point at the current commit. The command refuses a partial target set and does not create a tag. No current handoff meets the `verified` gate.

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

## Node 24.20 toolchain refresh

The current build policy pins Node `24.20.0` and npm `11.19.0`, matching MyAgents `0.4.15`'s official bundled distribution. Root engines/devEngines, CI, launchers, protocol fixtures, Runtime self-check and artifact construction share that exact requirement. The official DSH source and patch series stay fixed; rebuilding their artifact changes the build provenance and accepted manifest digest. Earlier Node `24.14.0` / npm `11.15.0` deliveries remain immutable historical evidence.

Source validation must consume the accepted patched DSH packages through the package installer; an untouched registry install does not contain the session-projection and other public-seam patches used by this Runtime. The accepted artifact manifest and offline consumer lock provide those package bytes; never edit installed package source to emulate the patches.

The subsequent Runtime/native/handoff receipts belong to the Host integration ledger and external release record. Windows/Linux remain pending native validation until campaigns run on those platforms.

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

1. Read the active PRD/RFC and this module guide.
2. Run the repository gates under the exact toolchain.
3. Prove the checkout clean both before and after Runtime construction, and retain/compare its input
   digests; build into a new external directory.
4. Run the required deterministic, native, dynamic, security, and platform campaigns.
5. Generate a new handoff; never copy selected files into an old one.
6. Verify a transferred clean-directory copy while supplying the trusted outer digest. The current
   `verify.mjs` argument is optional, so callers must treat a missing expected digest as unauthenticated
   internal-consistency checking, not release identity verification.
7. Update PRD/plan status only after exact evidence is accepted.

Before stronger self-contained claims, make all platform evidence Runtime-bound/schema-checked,
add Runtime and Batch 3 end-of-window cleanliness checks, derive notices from the final dependency
closure, scan the outer inventory, require the expected digest, and cross-check copied
profile/protocol identities. Exact signing and notarization belong to the consuming release
pipeline. Local unsigned development acceptance may prove functionality but cannot be relabeled as
signed distribution evidence.

The pre-artifact campaign accepts `--dsh-source /absolute/path/to/official-checkout` when the optional sibling checkout lacks the pinned upstream object. It runs the same source/blob/compile verification on that exact checkout and records the commands; it does not mutate or replace the sibling checkout.

## Host startup verification

The official handoff verifier returns its already verified nested Runtime together with a self-check report derived from that inventory and the executing Node/platform. MyAgents performs this combined scan once per Sidecar installation identity, then retains the existing actual-process initialize/status handshake. It no longer starts a second full Runtime self-check scan or a separate Node version subprocess. Standalone `--self-check` remains available. This reuses one verification result rather than adding a cache with a new trust model. The public standalone protocol contract is an inventoried handoff output generated by the official builder.


UPG15 Runtime construction resolves the pi-ai package/version from the fixed pi-ai seam source authority, and compatibility generation declares 0.85.1. A regression ties that declaration back to the fixed source to catch drift that adapter-only tests cannot reach. These are candidate build facts; current-byte Runtime/native/Host evidence remains required before acceptance.
