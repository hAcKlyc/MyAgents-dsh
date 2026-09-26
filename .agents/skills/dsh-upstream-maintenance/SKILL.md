---
name: dsh-upstream-maintenance
description: Audit or integrate a new official DeepSeek Harness revision into MyAgents-dsh, decide which upstream capabilities to adopt or use to replace product code, adjudicate every recorded seam patch, and rebuild exact evidence. Use for DSH version, capability, public-seam, patch, or artifact updates; do not use for ordinary product feature work.
---

# DSH upstream maintenance

Maintain the pinned DSH source and patched distribution while using official, maintained capabilities wherever they serve the accepted MyAgents product. Do not create a long-lived fork, edit installed dependencies, or inherit evidence from old bytes.

## Product and capability decisions

- MyAgents owns harness composition and integration, product state, permissions, credentials, cross-runtime behavior, and the user experience. DSH owns its native AgentLoop, execution services, tools, and durable runtime conversation. Define the owner for the specific fact and lifecycle phase before replacing code; do not create a second writer or a parallel model-facing path.
- Prefer official DSH implementations for capability and experience improvements. Compare the actual public interface and executable behavior with the current product path. Adopt an official package when it provides a real user benefit and can satisfy the complete product contract; remove superseded local behavior and retain meaningful contract regressions when that contract is proven. Package presence in the build is not an activated, usable feature.
- When official behavior covers only part of the contract, keep the missing product-specific policy in the smallest adapter over public seams. Add a DSH core patch only for an exact required semantic unavailable through public composition. Do not preserve a local implementation merely for historical compatibility when the accepted prelaunch scope explicitly allows removing its old logic and development data; never infer permission to discard released or user data.
- A capability is complete only when its permissions, dependencies, recovery, platform behavior, and user-facing result work together. Security and durability failures must be explicit; do not silently run an unconfined fallback or advertise a feature whose resources are absent.
- Apply accepted product principles and PRD decisions to ordinary engineering tradeoffs. Ask for a product decision only when the candidate would materially change user-visible behavior or authority and no existing decision settles it. Keep such questions separate from code adaptation choices.

## Architecture truth

An official DSH update is not a normal dependency bump. Review every entry in `specs/dsh/seam-decisions-v1.json` against the new exact source and classify it as:

- **retire**: official public semantics and executable tests fully replace the local patch;
- **reduce**: official DSH now owns part of the behavior, so shrink the patch to only the missing semantic;
- **rebase**: the semantic is still absent and no public seam can express it, so rewrite the smallest upstream-ready patch against the new source.

Clean patch application is not acceptance. Never fuzzy-apply a patch, edit `node_modules`, modify the sibling upstream checkout in place, or carry an obsolete patch because it still compiles.

## Choose the operating mode

- For an audit, version check, or review request: perform read-only discovery and produce the capability and seam comparison/disposition matrices. Do not update pins, patches, manifests, or artifacts.
- For an explicit update request: perform the full workflow and update all affected authorities and evidence.

Do not broaden an audit into a repository mutation.

## Read before acting

Read these complete authorities in order:

1. repository `AGENTS.md` (also exposed as `CLAUDE.md`);
2. `specs/ARCHITECTURE.md`, especially DSH foundation and extension policy;
3. `specs/dsh/README.md` and `specs/dsh/seam-decisions-v1.json`;
4. all ADRs referenced by the seam registry;
5. any module guide affected by upstream changes, including `specs/tech_docs/execution/compaction.md`;
6. [references/patch-inventory.md](references/patch-inventory.md).

Local ignored planning drafts may add context, but a clean checkout and release gate cannot depend on them.

Treat code, tests, package manifests, the lockfile, generated registries, and artifact manifests as the exact-byte authority.

## Workflow

### 1. Protect the working state

1. Confirm the repository branch and inspect `git status`.
2. Preserve unrelated user changes. Stop if an upstream refresh would overlap edits whose ownership cannot be determined.
3. Inspect the sibling DSH checkout without changing it. Fetch only when the request authorizes checking or integrating upstream state.
4. Resolve an immutable upstream commit and tree. A tag or registry version alone is insufficient.

### 2. Establish the candidate source and package truth

Record:

- upstream repository URL, tag/release, exact commit, and tree;
- declared workspace package versions;
- public package exports and relevant public service/event/type seams;
- registry tarball identity and whether its association with source is proven;
- Node, npm, and pnpm identities required by repository build policy;
- license and complete production dependency closure changes.

Compare behavior and public contracts, not only version strings or file diffs.

For newly available or changed official capabilities relevant to MyAgents, record the product benefit, current implementation, state owner, required adaptation, and decision: **adopt**, **replace local implementation**, **defer for an explicit product capability**, or **exclude**. Distinguish an implementation task from an unsettled product choice; do not leave a technical compatibility question as an open product decision. Include the capabilities needed by the accepted upgrade scope without treating every upstream workspace package as a product plugin.

### 3. Build the mandatory seam matrix

Create one row for every registry entry, including the patchless `DSH-SEAM-004`. Each row must contain:

| Field | Required finding |
| --- | --- |
| Seam | exact product semantic being protected |
| Official candidate | public API and executable behavior now present |
| Gap | complete, partial, or absent |
| Disposition | retire, reduce, rebase, or keep public composition |
| Product impact | imports, composition, persistence, protocol, or lifecycle consumers |
| Evidence | focused upstream test plus product-level fixture/campaign needed |
| Removal condition | whether the recorded condition is now satisfied |

For each patch, inspect its entire diff and every touched upstream file after all preceding patches in series order. A later patch may depend on earlier post-images.

### 4. Adjudicate each patch

Use these rules:

- **Retire** only when the candidate exposes the full semantic through a permitted public package root and an executable regression proves it. Remove the patch, product dependency on patched API, registry entry or patch field as appropriate, and supersede/update its ADR.
- **Reduce** when upstream adopted a strict subset. Delete the adopted portion and retain only independently necessary behavior with a new minimal regression and removal condition.
- **Rebase** only after proving no public service, event, guard, registration, or replacement Provider can express the requirement. Recreate the patch against exact candidate blobs; do not resolve it by fuzzy context.
- **Keep public composition** when the existing product Provider/plugin composition remains sufficient; do not invent a patch for symmetry.

If upstream behavior materially changes product semantics rather than merely supplying an accepted seam, first check the user's accepted principles and the active PRD. Request the owning product decision before implementation only when neither settles the change.

### 5. Update the authority chain atomically

For an accepted update, revise together:

1. source baseline and exact source/blob/digest authority;
2. ordered patch files and `scripts/dsh-seam-decisions.ts`;
3. generated `specs/dsh/seam-decisions-v1.json` via the repository generator;
4. affected ADR status, new ADRs, and upstream refresh review;
5. dependency manifests, exact lock, license/dependency closure, and public compile fixture;
6. patched-artifact package set, builder policy, accepted profile, and compatibility manifest;
7. affected module architecture documents and `specs/dsh/README.md`;
8. Runtime artifact, native/platform evidence, and Batch integration handoff;
9. project plan and active ledger status.

Never hand-edit a generated projection when its source generator owns it.

### 6. Verify in escalating layers

Run the repository's exact scripts with the locked toolchain. At minimum:

1. `npm run check:dsh-source`
2. `npm run check:dsh-seams`
3. `npm run check:dsh-seams-source`
4. build the patched DSH artifact twice and prove byte identity;
5. `npm run verify:dsh-artifact` against the new expected manifest;
6. clean-consumer public-surface and dependency-closure verification;
7. `npm run check:dsh-runtime-composition`;
8. targeted Runtime tests for every affected seam;
9. `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`;
10. affected packed, fault, soak, native, dynamic-Agent, security, and Host-handoff campaigns.

Use fake adapters, fake Host ports, temporary homes/workspaces, and no credentials for default tests. Credential-backed evidence uses request-scoped secrets outside repository artifacts and logs.

Native evidence is identity-bound. If Windows or Linux machines are unavailable, label complete implementations `implementation-complete_pending-native-validation`; do not call them verified or unsupported.

### 7. Report the outcome

The final maintenance report must include:

- old and new release/commit/tree identities;
- official capabilities adopted, excluded, or used to replace local code, with the owner and complete-delivery rationale;
- one disposition and rationale for every seam/patch;
- patch count and ordered patch-series digest before and after;
- public API and product-composition changes;
- rebuilt artifact, Runtime, platform, and handoff identities;
- gates run and any honest pending-native-validation labels;
- remaining upstream contribution/removal follow-ups.

Old manifests and reports remain historical evidence for old bytes. Never present them as proof for the new candidate.

## Hard stops

Stop rather than guessing when:

- the candidate cannot be resolved to an immutable commit/tree;
- upstream source/package association is unknown and a claim depends on it;
- a required public seam is ambiguous or only package-private;
- user changes overlap a patch or authority file and cannot be preserved safely;
- official behavior creates a new product-policy decision not settled by the user or active PRD;
- real-route credentials or a required native machine are unavailable for a release claim.

Unavailable evidence is pending, not passing.
