# DSH upstream rebaseline: `0.1.1-rc.2`

Status: accepted under Batch 1 action `B1-DSH-R1` at implementation commit
`336899ee0a4d4cf7614031cfaddb358a7400c529`.

This record compares the current MyAgents source/design baseline with the newest
reviewed official DSH release. It is the accepted source, patch, package, and
Runtime evidence authority for the rest of Batch 1. The candidate profile remains
internal `workstream-evidence-only`; this checkpoint does not activate a public
Host surface or complete Workstream 3.

## Final refresh successor gate

`B1-DSH-R2` is the mandatory successor to this accepted mid-Batch rebaseline.
It remains `in_progress` until Workstream 4 implementation is frozen. A fresh
fetch on 2026-08-23 found no newer upstream delta: official `origin/master` and
the newest release tag both still resolve to commit
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` and tree
`53915efe4e2126cc7779b73dfc8a3bcec5318c44`.

Before Batch 1 acceptance, the final gate must fetch again, record both the
newest release and unreleased upstream head, repeat the patch dispositions and
capability-to-Batch mapping, choose one immutable source authority, and rebuild
all DSH/consumer/profile/protocol/Runtime evidence from it. The moving upstream
branch is review input, never an implicit production dependency.

## Immutable upstream identity

| Field | Prior authority | Rebaseline candidate |
| --- | --- | --- |
| Release | `0.1.0-rc.5` | `0.1.1-rc.2` |
| Git ref | fixed commit | lightweight tag [`dsh-v0.1.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.1-rc.2) |
| Commit | `47f943859bef60e4160492346772ded9b24f765a` | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` |
| Tree | `f904efab9ef435201d6ba4da88a34d6366568272` | `53915efe4e2126cc7779b73dfc8a3bcec5318c44` |
| Commit distance | — | 854 commits |
| Root package manager | pnpm `11.7.0` | pnpm `11.7.0` |
| Root Node range | previous pinned source range | `^22.19.0 || >=24.0.0` |
| Published package family | source association unproven for the old rc.6 executable baseline | `0.1.1-rc.2` packages are published with repository/directory metadata, but still omit `gitHead`; the custom patched artifact remains source-built and content-addressed |

The upstream checkout was fetched without switching or modifying its `master`
worktree. The local branch remains at the prior baseline while `origin/master`
and the release tag resolve to the candidate identity above.

## Patch re-adjudication

| Patch | Candidate finding | Required disposition |
| --- | --- | --- |
| 0001 `wakePending` | Applies cleanly; the release has no same-named public exact-existing-Inbox wake seam. | Retain and rebase with new blob identities/tests unless a behaviorally equivalent public seam is found during runtime review. |
| 0002 `agent/pre-assistant-commit` | Applies cleanly; the release still lacks an authoritative pre-assistant tool-input transform spanning history, permission, execution, result, and resume. | Retain and rebase; add interaction with the new interrupted-assistant path to the regression matrix. |
| 0003 persistence known-event predicate | The coordinator hunk applies; the test hunk conflicts only because upstream added persistence seed-ownership coverage at the insertion site. The generated known-event set still explicitly excludes downstream plugin events. | Retain the minimal option/predicate, rebase tests over the new coordinator suite, and re-prove required MyAgents events plus stock refusal. |
| 0004 Agent/Session publication guards | Applies cleanly; no same-named synchronous pre-publication guards exist. | Retain and rebase. |
| 0005 product-owned continuable lifecycle | Conflicts with upstream continuation evolution. `registerContinuableSetup` already existed in the prior baseline; the release newly adds caller-reserved `childId` and `drainContinuableChildren`, overlapping identity reservation and selected-tree retirement. It still lacks external settlement ownership, exact pending-message cold wake, strict external final durability, and infrastructure-failure attribution. | Split the patch. Replace product retirement calls with upstream selected-child drain wherever its live-parent authority is equivalent; retain only still-missing external settlement/recovery/durability facts. Do not duplicate upstream child identity or drain logic. |

No patch survives merely because it still applies. Removal is decided by exact
observable semantics and lifecycle ownership; retention requires new source
hashes, new tests, an upstream-ready isolated diff, and a removal condition.

## Capability-to-Batch mapping

| Upstream delta | Batch 1 target | Classification | Required integration action |
| --- | --- | --- | --- |
| Cancelled streaming attempts can append a durable interrupted assistant prefix; failed attempts no longer finalize the same way. | Exact operation terminal, event projection, retry/cancel durability | `use-upstream` | Add real-AgentLoop cancel/retry fixtures proving interrupted assistant messages cannot become false success, usage remains exact when known, and the projector preserves the delivered prefix before the aborted terminal. |
| Session known-event catalog grew, but remains build-closed and states that downstream event registration is deferred. | Product operation/plan/task/work/permission/checkpoint/mutation events in the one DSH log | `retain-minimal-patch` | Rebase 0003 and feed the exact required product-event predicate from the persistence composition. |
| SQLite persistence changed to a schema-owned optimized layout while the public backend contract remains append/list/load/repair and exposes no delete/replace transaction. | Workstream 4 production persistence, rewind/fork/delete | `compose-public-provider` | Re-run the W4 provider decision against the new codec. Reuse public coordinator contracts where possible; retain a MyAgents-owned mutation companion/shared backend when delete/locator/journal semantics remain absent. |
| Continuable subagents gained caller-reserved child identity, selected direct-child drain, richer diagnostics, and next-step report delivery. | ProductWork child identity, retirement, reconnect, cold recovery, exact settlement | `use-upstream` plus a reduced patch | Use reserved ids and selected-child drain instead of duplicating them. Re-test report-delivery rename/behavior and retain only external settlement/no-reinsert recovery/durability gaps. |
| Attachment APIs gained batch admission, per-side bounds, normalized references, deterministic request-image variants, and request-image projection. | Text/image input, tool/Hook/MCP output attachments, bounded Host leases | `use-upstream` plus `compose-public-provider` | Adapt the Host-backed AttachmentStore to the expanded public contract, including `maxImageDimension`, atomic batch behavior, and request-image projection over verified leased bytes. Preserve Host byte ownership and release semantics. |
| DeepSeek adapter gained vision, deterministic image request handling, Files API upload/index/fallback, and separated Files/stream timeouts. | One production DeepSeek route and actual image consumption | `use-upstream` | Replace the old text-only limitation. The external clean consumer must prove a validated image reaches the exact image-capable route, while text-only routes retain deterministic omission. No real key/network is used in default tests. |
| Stock MCP now projects image results through durable attachments after exact route capability checks. | Declarative MCP generations through Host credentials and the single ToolRuntime | `replace-product-owner` while reusing public vocabulary | Keep MyAgents component/MCP generation and Host-secret owners; do not install stock dynamic MCP lifecycle. Align result/image semantics with the new public DSH content/attachment types and keep atomic promotion/reconnect evidence. |
| CredentialProvider gained persistent credential-record methods and an AuthorizationService was added. | Host-owned, request/connection-scoped secrets with zero persistence | `exclude-stock` plus provider adaptation | Keep the Host reverse credential provider. Implement the expanded public Provider interface with record persistence unavailable/fail-closed; do not mount stock local credentials or authorization in the official profile. |
| New experimental Agent Teams, Python code runtime, persistent PowerShell tool, file-reference/client UI, and authorization packages were added. | Batch 1 canonical tools, child work, platform providers, no arbitrary extension activation | `exclude-stock` unless a later exact contract selects one | Do not widen the official package/profile closure merely because packages exist. Review public dependency closure transitively and include only packages required by selected roots. Agent Teams must not introduce a second child/work authority. |
| Upstream Python/ACP/SDK and UI surfaces evolved. | MyAgents/standalone SDK Hosts over the engine-neutral bidirectional native protocol | `exclude-stock` as product wire | Keep the single MyAgents native peer and generated Host. Upstream SDKs are compatibility evidence, not a replacement for reverse ports, operation terminals, mutations, or the Batch 1 lifecycle contract. |

## Required source and artifact changes

1. Regenerate the exact public npm `0.1.1-rc.2` dependency baseline and root lock;
   do not mix rc.6 declarations with the new source-built family.
2. Update every workspace peer range from the old custom/rc.6 pair to the new
   custom artifact plus its reviewed public fallback, and prove one installed
   DSH/Cordis graph.
3. Rebase the reduced patch series and its touched-blob authority, then update
   `PATCHED_DSH_ARTIFACT_PACKAGE_COUNT`, root package projection, exact external
   roots, compile fixtures, and artifact version from computed closure evidence
   rather than copying the old 52-package count.
4. Adapt MyAgents providers and consumers to changed public types, especially
   attachments, credentials, LLM content/model metadata, subagent lifecycle,
   Session events, and persistence.
5. Re-run the W1–W3 focused regression matrix against the new package graph before
   starting W4. W4 decisions use only the new persistence API/codec evidence.
6. Rebuild the content-addressed patched DSH bundle, clean offline consumer,
   candidate profile/protocol projections, and commit-bound Runtime artifact.

## Acceptance evidence

- exact upstream source build and the reduced rebased patch tests pass with one
  Vitest worker;
- public-surface compile and private-import refusal pass against the new packed graph;
- clean offline `npm install`, removal, `npm ci`, `npm ls --all`, and TypeScript
  compile pass with one unique custom DSH family and no rc.5/rc.6 residue;
- the repository-external real patched AgentLoop passes success, failure, cancel,
  durable interrupted-prefix, Hook-transform, child retirement/recovery, normalized
  image input, Host attachment/image, and shutdown-cleanup flows;
- root `typecheck`, `lint`, forced-single-worker `test` (38 files / 402 tests), and
  `build` pass with security coverage of 296 cached-or-untracked files and 26
  actual packed archives;
- the commit-bound Runtime artifact at
  `/private/tmp/myagents-dsh-b1-rebaseline-runtime-artifact-v3` independently
  verifies with manifest
  `bb77dc7d957a1fb5cb119995e90a75dc97169faf8a178c392ef961eaa4d9d038`,
  7183 canonical entries, repository head
  `336899ee0a4d4cf7614031cfaddb358a7400c529`, builder authority
  `23bf52b5d3987260583ed6575572eef70e55d90120b1d3b08720f7c8dfb48afa`,
  and root lock
  `5be2c741dedad0b32a9846fbf910d4b9223d94bd8abf1bbf74ec288620156d91`;
- the clean consumer observes 35 canonical tool calls, 211 contiguous Runtime
  events, 24 operation terminals, exact durable interrupted assistant-prefix
  ordering, normalized image/Host-tool references, and the installed Runtime
  process lifecycle matrix;
- candidate profile file SHA-256 is
  `61ac171de1890728cd8b74c8cb2e4d05caccbef30c0571dfeb2a9f34802548ed`,
  capability-profile digest is
  `80d3f130738d75c57caa6ad6d233b6f2cfc57a7ad3a786985d985445c7177d02`,
  protocol schema SHA-256 is
  `16519d3b23ccc98475ed517bf14cd1711f7dfcc0afd207b5fb3faf2541365412`,
  and activation remains `workstream-evidence-only`.

## Current rebased evidence

The source and package rebaseline now has the following accepted-candidate evidence:

- the reduced five-patch source gate passes 10 files / 371 tests and the selected upstream TypeScript projects under the exact Node `24.13.1`, pnpm `11.7.0`, and TypeScript `5.9.3` authority;
- the deterministic bundle contains 52 custom-version DSH packages and 44 direct roots at version `0.1.1-rc.2.myagents.b150a551b8d4.1104f84a3f49`;
- offline `npm install`, tree removal, fresh `npm ci`, `npm ls --all`, public/patched compile fixtures, and existing-bundle verification pass in the isolated clean consumer;
- the bundle manifest is `b937254ae7bdd756988c4e253dc215cbed252b6ea2f9bdc444e5a51ee812c4ae`, `SHA256SUMS` is `e28ab282cee23e2b41f6a8b8dd2b03e5e2b32a87b9aafaf95234ea7c4d14bda8`, builder authority is `dcf3043171888d3f67374df8b04d3bb9f3e59900d98db08d76e8ed5288c122d6`, root lock authority is `5be2c741dedad0b32a9846fbf910d4b9223d94bd8abf1bbf74ec288620156d91`, and consumer lock is `4bc1fa9178561acd8e9b49b5fe548d03db88368178b5e70af7a8a6c823856117`;
- candidate profile and protocol projections bind that manifest; protocol schema SHA-256 is `16519d3b23ccc98475ed517bf14cd1711f7dfcc0afd207b5fb3faf2541365412`, while activation remains `workstream-evidence-only`;
- focused MyAgents attachment/model/work/declarative/baseline regression passes 5 files / 63 tests.

This closes `B1-DSH-R1`. Workstream 3 action A10 remains the next development
and acceptance action; Workstream 4 starts only after that accumulated lifecycle,
reconnect, cleanup, and security gate is accepted.
