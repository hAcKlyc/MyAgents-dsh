# Current DSH seam and patch inventory

This maintenance projection covers all sixteen entries in `specs/dsh/seam-decisions-v1.json`.
The generated registry owns exact source blobs, patch hashes, ordering and removal conditions.
Candidate dispositions require the owning Product, artifact, native and Host gates before final acceptance.

## Source and artifact model

- Fixed DSH `0.2.1-rc.2`, commit `687f282e8625c6b8d11ff58211a90524be2e4317`, tree `f127f0f96a815eac4dea336a2ae0d9cd0f2aa82d`.
- Registry source association is unproven; source authority and npm resolution are separate facts.
- Thirteen core patches produce 104 required DSH packages. The artifact builder compares two independent packing passes byte-for-byte; later source/lock/build-policy changes require fresh acceptance.
- pi-ai `1.1.0`, commit `abe508e1b89912adde45528136c3221eb69acdd7`, tree `77d78fae728879c16550b1f874785aed7851233c`, has two separately verified source patches: Provider-owned content and the official DSH six-transport deferred tool-argument parsing optimization.
- Verify original blobs, apply only to isolated worktrees, compile and pack content-addressed artifacts. Never edit sibling upstream, registry archives or installed dependencies in place.

Read current generated registries, package/lock files and accepted manifests before reporting identities.

## Complete disposition matrix

Patch filenames retain historical numbers; patch order is the registry's dense order.

| Seam / ADR | Candidate disposition / patch | Protected semantic and required proof |
| --- | --- | --- |
| 001 / 0001 | rebase / 0001-agent-wake-pending | Wake an existing native Inbox identity with FIFO, abort latch and one claim; restart must not reinsert it. |
| 002 / 0002 | rebase / 0002-pre-assistant-commit | Keep raw native stream evidence while committing and executing the final governed tool arguments through the authoritative waterfall and current scoped dispatch. |
| 003 / 0003 | rebase / 0003-jsonl-product-event-validation | Official JSONL owns storage and private tracker lifecycle; public `withStoredEventValidation(validator)` composes exact required Product payload validation with native validation. Required-event refusal and teardown failures remain observable. |
| 004 / 0004 | keep public composition / no patch | Official JSONL handles and Product metadata coordination share locator ownership, revision fencing and immutable rewind generations; no PersistenceBackend shim. |
| 005 / 0005 | rebase / 0004-publication-guards | Synchronous pre-publication guards reject extra root Session/Agent creation before publication. |
| 006 / 0006 | reduce / 0005-product-owned-continuable-lifecycle | Native `startActivation`, `waitForChildren`, `drainDescendants` and `prompt` own asynchronous scheduling. Retain released version 5 descriptor admission, identity and lineage; externally owned historical children remain readable but cannot be continued by the native parent. Delegation context defers approval outcomes to the effective policy; test native never and Host ask. |
| 007 / 0007 | retire / no patch | Native DeepSeek translator preserves established tool identity across empty continuation fields. Re-run translator and Product streaming regressions. |
| 008 / 0008 | rebase / 0007-capacity-safe-compaction | Reuse native request pricing; retain largest balanced fitting range, structured summary validation/one repair, provenance and content-free telemetry. |
| 009 / 0009 | reduce / 0008-literal-prompt-contributions | Stock literal sections/contexts own new contributions; retain validation and restoration of released version 5 `personaInterpolate` without adding a new-start persona policy. |
| 010 / 0010 | rebase / 0009-agent-instruction-selection | First non-empty candidate per directory, last-known-good transient failure and canonical Read/Write/Edit touches. |
| 011 / 0011 | rebase / 0010-pi-ai-provider-content | Generic Provider blocks survive pi-ai/DSH conversion and exact route replay, preserving requested/response model identity without local ToolRuntime claims. |
| 012 / 0012 | rebase / 0011-file-tool-composition | Public official tool factories, stored-edit preview and publication callback preserve BOM/CRLF, atomic writes, parent creation, image dimensions and platform ACL behavior through current async workspace context. |
| 013 / 0009 | retire / no patch | Native `PromptContext.interpolate` reaches assembly and rendering; Host and Skill literal contributions use the public flag while ordinary contexts retain strict interpolation. |
| 014 / 0013 | rebase / 0013-host-neutral-time-context | Native time and elapsed remain available without browser-only clarification; old unavailable readings remain valid, resolved/mixed policies remain enforced. |
| 015 / 0014 | rebase / 0014-session-projection-public-types | Constrain public projection registration to host state keys; the required conditional wire type also enforces wire membership. Strict client-only, host-only and complete-map compilation must work without private fold imports; emitted runtime behavior is unchanged. |
| 016 / 0015 | rebase / 0015-model-update-capabilities | Native exact-model compat configuration supplies both capability metadata and Provider serialization. Test model/schema admission, real loopback requests, explicit false, omission and sibling isolation; reject route-wide and wrong-family declarations. |

## Dependencies and retirement boundaries

- Apply in registry order. Later Agent-loop and subagent changes can depend on earlier post-images.
- Seam 003 removal requires official trusted extension validation including native validator plus every Product required payload, hashes, lineage, close/recovery and unknown-ignorable handling. Product supplies only its payload validator; private trackers and codecs stay native.
- Seam 004 requires cross-process ownership evidence. POSIX flock and Windows global mutex claims must match native-platform receipts.
- Seam 006 uses native asynchronous lifecycle and Inbox projection; preserve released version 5 reads without restoring a second scheduler or Inbox. New children write native version 3; old-reader downgrade support must not be inferred from old-history compatibility.
- Seam 008 must retain one native request estimator. Read `specs/tech_docs/execution/compaction.md` before changing compaction. Native graph/surface operations, pressure/overflow hooks, pruner and manual lifecycle remain upstream owners.
- Seam 009 preserves historical literal persona without rewriting old Session bytes. Seam 013 is retired because the native context flag supplies the complete literal-context contract; retain its regressions.
- Seam 011 depends on the separately pinned pi-ai Provider-content patch and keeps canonical tool execution distinct from Provider observations. The independent pi-ai parsing patch preserves DSH's official streaming optimization when source-built pi-ai replaces the registry package.
- Seam 012 requires Product permissions/checkpoints and native-platform file evidence, not only clean patch application.
- Seam 015 requires strict packed-consumer declaration checks with client-only augmentation. Importing private fold state, disabling declaration checks or erasing public types is not equivalent proof.
- Seam 016 keeps exact-model facts in the native configuration owner and materialized model. Its removal requires matching metadata and actual wire behavior, conservative omission/false handling and same-route model isolation; a metadata-only or route-wide override is insufficient.
- Any patch change alters the series digest and every patched package version. Rebuild DSH, Runtime, platform evidence and immutable handoff; do not relabel old reports.

## Authority and command map

| Concern | Source |
| --- | --- |
| Seam decisions / exact registry | `scripts/dsh-seam-decisions.ts`, `specs/dsh/seam-decisions-v1.json`, ADRs 0001–0015 |
| DSH baseline / patches | `specs/dsh/dsh-baseline-v1.json`, `specs/dsh/README.md`, `specs/dsh/patches/` |
| pi-ai seam | `specs/pi-ai/seam-evidence-v1.json`, `specs/pi-ai/README.md` |
| Runtime/Host acceptance | `specs/tech_docs/assurance/verification-artifacts-and-handoff.md`, exact artifact manifests and the trusted Host release record |
| Source and seam verification | `check:dsh-source`, `check:dsh-seams`, `check:dsh-seams-source` |
| Artifact and Product composition | `build:dsh-artifact`, `verify:dsh-artifact`, `check:dsh-runtime-composition` |
