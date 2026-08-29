---
type: technical-architecture
status: implemented-runtime-delivery
module: artifact-verification-and-handoff
updated: 2026-08-29
product_scope:
  - ../prd/prd_0.1_agent_runtime.md
  - ../prd/prd_0.3_myagents_integration.md
implementation_decisions:
  - ../prd/tech_rfc_0.1_verification_release.md
  - ../prd/tech_rfc_0.3_myagents_dsh_integration.md
---

# Artifact verification and integration handoff

## 1. Purpose

The release system turns exact source, dependencies, DSH patches, generated contracts, Runtime bytes, platform evidence, and compatibility claims into independently verifiable immutable deliveries. A passing source checkout is not itself a Runtime artifact, and an artifact for old bytes cannot authorize new bytes.

## 2. Evidence chain

```text
pinned DSH source + ordered patches + exact stores/toolchain
  -> patched DSH artifact
  -> official Runtime artifact
  -> native/platform evidence
  -> compatibility manifest
  -> Batch 3 integration handoff
```

Every edge is content-addressed. Builders reject dirty repositories, mismatched source commits, unexpected files, symlinks/hardlinks/special files, forbidden content, dependency drift, and evidence bound to another Runtime manifest.

## 3. Code and builder ownership

| Concern | Authority |
| --- | --- |
| Runtime/artifact inventory and self-check | `packages/artifact-verifier/src/runtime-artifact.ts`, `self-check.ts` |
| Compatibility declaration | `integration-compatibility.ts` |
| Batch 3 outer handoff and generated README | `integration-handoff.ts` |
| DSH artifact construction | `scripts/build-patched-dsh-artifact.ts` |
| Runtime composition verification and artifact construction | `scripts/verify-dsh-runtime-composition.ts` |
| Native campaign | `scripts/run-batch-1-native-campaign.ts` |
| Batch 3 handoff | `scripts/build-batch-3-integration-handoff.ts` |

The handoff nests the complete Runtime artifact and its verifier, generated protocol/client/tool/profile contracts, compatibility manifest, exact platform evidence, notices, an outer verifier, and a generated root README. The README is onboarding; manifests and generated contracts remain the machine authority.

## 4. Platform claims

`verified` requires a passing native report for the exact Runtime manifest. A complete adapter whose native campaign has not run is labeled `implementation-complete_pending-native-validation`. MyAgents may advertise only the intersection of its product policy and the exact artifact-bound claims.

## 5. Rebuild and update rule

Any source, DSH, patch, lock, builder, protocol, profile, compatibility, Runtime, or platform-evidence change produces a new identity. Official DSH refreshes must adjudicate every seam as retire/reduce/rebase before rebuilding the full chain. Accepted handoffs are never edited in place.

The Batch 3 builder requires a clean checkout, a verified Runtime artifact bound to current `HEAD`, one exact three-platform claim file, and matching content-addressed evidence. It automatically regenerates and inventories the semantic README, seals the outer manifest, verifies the directory, and prints the out-of-band handoff digest.

## 6. Security boundary

Artifacts and evidence contain no credentials, private prompts, transcripts, user files, workspace content, attachment bytes, or local Runtime homes. Dependency and license notices are derived from exact production closure. Temporary paths and caches are never release authority.

## 7. Maintenance checklist

1. Read the active PRD/RFC and this module guide.
2. Run the repository gates under the exact toolchain.
3. Build from a clean commit into a new external directory.
4. Run the required deterministic, native, dynamic, security, and platform campaigns.
5. Generate a new handoff; never copy selected files into an old one.
6. Verify a transferred clean-directory copy against the trusted outer digest.
7. Update PRD/plan status only after exact evidence is accepted.
