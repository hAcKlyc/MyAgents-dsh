# Current DSH seam and patch inventory

This maintenance projection covers all thirteen entries in `specs/dsh/seam-decisions-v1.json`.
The generated registry owns exact source blobs, patch hashes, ordering and removal conditions.
UPG17 dispositions require the owning Product, artifact, native and Host gates before final acceptance.

## Source and artifact model

- Fixed DSH `0.1.7-rc.2`, commit `477b4f420553e8a52c2fbccc464d7561b239c443`, tree `e3e63253d1d35ad07f785273235c40813cb6c8bd`.
- Registry source association is unproven; source authority and npm resolution are separate facts.
- Ten core patches produce 89 required DSH packages. Two independent UPG17 package builds match byte-for-byte; later source/lock/build-policy changes require fresh acceptance.
- pi-ai `0.85.1`, commit `d981de1229ef899957bbe968bc8dcda02a21f477`, has a separately verified Provider-content patch.
- Verify original blobs, apply only to isolated worktrees, compile and pack content-addressed artifacts. Never edit sibling upstream, registry archives or installed dependencies in place.

Read current generated registries, package/lock files and accepted manifests before reporting identities.

## Complete disposition matrix

Patch filenames retain historical numbers; patch order is the registry's dense order.

| Seam / ADR | Candidate disposition / patch | Protected semantic and required proof |
| --- | --- | --- |
| 001 / 0001 | rebase / 0001-agent-wake-pending | Wake an existing native Inbox identity with FIFO, abort latch and one claim; restart must not reinsert it. |
| 002 / 0002 | reduce / 0002-pre-assistant-commit | Keep raw native stream evidence while committing and executing the final governed tool arguments through one synchronous waterfall. |
| 003 / 0003 | retire / no patch | Public SessionHandle Provider composes native V4 validation with exact Product payload validators; unknown required and malformed known events refuse. |
| 004 / 0004 | keep public composition / no patch | Product SQLite handles and mutation companion share writer ownership, revision fencing and immutable rewind generations; no PersistenceBackend shim. |
| 005 / 0005 | rebase / 0004-publication-guards | Synchronous pre-publication guards reject extra root Session/Agent creation before publication. |
| 006 / 0006 | rebase / 0005-product-owned-continuable-lifecycle | Explicit child setup, descriptors, ancestry/depth, resident quiet parent, external settlement, strict flush and failure attribution. |
| 007 / 0007 | retire / no patch | Native DeepSeek translator preserves established tool identity across empty continuation fields. Re-run translator and Product streaming regressions. |
| 008 / 0008 | rebase / 0007-capacity-safe-compaction | Reuse native request pricing; retain largest balanced fitting range, structured summary validation/one repair, provenance and content-free telemetry. |
| 009 / 0009 | reduce / 0008-literal-prompt-contributions | Native literal PromptSection removes duplicate interpolation; child persona and continuation semantics remain patched. |
| 010 / 0010 | rebase / 0009-agent-instruction-selection | First non-empty candidate per directory, last-known-good transient failure and canonical Read/Write/Edit touches. |
| 011 / 0011 | rebase / 0010-pi-ai-provider-content | Generic Provider blocks survive pi-ai/DSH conversion and exact route replay, preserving requested/response model identity without local ToolRuntime claims. |
| 012 / 0012 | rebase / 0011-file-tool-composition | Public official tool factories, stored-edit preview and publication callback preserve BOM/CRLF, atomic writes, parent creation, image dimensions and platform ACL behavior. |
| 013 / 0009 | rebase / 0012-literal-runtime-context | Native literal PromptSection is reused; PromptContext remains strict upstream, so the patch adds explicit literal handling for Host and Skill context bodies. |

## Dependencies and retirement boundaries

- Apply in registry order. Later Agent-loop and subagent changes can depend on earlier post-images.
- Seam 003 retirement includes native validator plus every Product required payload, hashes, lineage, close/recovery and unknown-ignorable handling.
- Seam 004 requires cross-process ownership evidence. POSIX flock and Windows global mutex claims must match native-platform receipts.
- Seam 006 uses native asynchronous lifecycle and Inbox projection; do not restore retired descriptor versions or a second inbox.
- Seam 008 must retain one native request estimator. Read `specs/tech_docs/execution/compaction.md` before changing compaction. Native graph/surface operations, pressure/overflow hooks, pruner and manual lifecycle remain upstream owners.
- Seams 009 and 013 preserve the persona and context planes; old-session descriptor migration is outside UPG17 scope.
- Seam 011 depends on the separately pinned pi-ai patch and keeps canonical tool execution distinct from Provider observations.
- Seam 012 requires Product permissions/checkpoints and native-platform file evidence, not only clean patch application.
- Any patch change alters the series digest and every patched package version. Rebuild DSH, Runtime, platform evidence and immutable handoff; do not relabel old reports.

## Authority and command map

| Concern | Source |
| --- | --- |
| Seam decisions / exact registry | `scripts/dsh-seam-decisions.ts`, `specs/dsh/seam-decisions-v1.json`, ADRs 0001–0012 |
| DSH baseline / patches | `specs/dsh/dsh-baseline-v1.json`, `specs/dsh/README.md`, `specs/dsh/patches/` |
| pi-ai seam | `specs/pi-ai/seam-evidence-v1.json`, `specs/pi-ai/README.md` |
| Runtime/Host acceptance | `specs/tech_docs/assurance/verification-artifacts-and-handoff.md`, exact artifact manifests and the trusted Host release record |
| Source and seam verification | `check:dsh-source`, `check:dsh-seams`, `check:dsh-seams-source` |
| Artifact and Product composition | `build:dsh-artifact`, `verify:dsh-artifact`, `check:dsh-runtime-composition` |
