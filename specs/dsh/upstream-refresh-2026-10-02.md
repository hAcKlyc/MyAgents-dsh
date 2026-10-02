# Official native JSONL adoption for DSH 0.2.0

Date: 2026-10-02. Source remains official `dsh-v0.2.0-rc.2`, commit
`639ed015397290b3745d163aafe02ffee4aa3f84`, tree
`ac66a6a3e77f6fa396509ddfecc7beacf0cf642a`. The previous source revision was already pinned;
this refresh replaces the unreleased product SQLite Session backend with official native JSONL.
Registry archive/source association remains unproven; the source-built artifact owns executable bytes.

## Capabilities and owners

| Capability | Decision and complete delivery |
| --- | --- |
| Official JSONL create/open/read/append/stat/list/flush/close | Replace custom Session backend and handle batching; delegate through public package-root APIs. |
| Native V4 codec, zstd/checksums, physical write leases, torn-tail recovery | Adopt unchanged; no product encoder, decoder, retry buffer or native lease implementation. |
| Native fork seed and inherited marker | Adopt `buildForkSeed` before the product fork receipt; exact inherited cut remains native metadata. |
| Product rewind/fork/delete and file recovery | Keep only missing product transaction/journal/locator/checkpoint coordination; no SQLite Session event table. |
| Required product event recognition | Reduce patch 003 to a protected native validation hook; exact Product payload validation and unknown-required refusal remain. |
| Native Session query SQLite | Keep the official disposable in-memory derived index; it is independent of native JSONL persistence. |
| Historical development logs/schema conversion | Exclude under the approved prelaunch scope; remove old code and manually remove obsolete development Sessions while writers are stopped. |

## Complete seam adjudication

Other patches retain their current exact source and semantics; this refresh does not reconstruct
any of their upstream owners. All rows are covered by the source suite, public compile fixture and
fresh packed Runtime composition. Product/native evidence must bind the rebuilt artifact.

| Seam | Candidate API / gap | Disposition | Product impact / evidence | Removal condition |
| --- | --- | --- | --- | --- |
| 001 | Native Inbox lacks same-ID pending wake | rebase | Operation recovery; native wake/FIFO/cancel source tests and packed operations | Equivalent native wake and tests |
| 002 | Native commit lacks final governed-arguments waterfall | reduce | Tool/history authority; native commit tests and packed tool calls | Equivalent authoritative transform |
| 003 | JSONL owns storage but required Product event registration is absent | reduce | Protected hook only; stock admission tests plus cold Product payload/refusal/flush tests | Official trusted validation extension |
| 004 | Public JSONL handles lack product mutation transactions | keep public composition | Native logs plus locator/journal/checkpoint store; rewind/fork/delete/fault/contention tests | Complete native product mutation semantics |
| 005 | Pre-publication root admission absent | rebase | Existing root/child guards; native publication tests and packed composition | Equivalent synchronous guard |
| 006 | External child settlement/quiet ancestry incomplete | rebase | Existing native continuation composition; source and packed child recovery | Complete native lifecycle seams |
| 007 | Native translator preserves established tool identity | retire | No patch; native stream and Product streaming regressions | Already satisfied |
| 008 | Native estimator exists; balanced capacity/repair semantic incomplete | rebase | Existing official compaction engine patch; capacity/manual/native composition tests | Equivalent engine behavior |
| 009 | Native literal section exists; child persona semantic incomplete | reduce | Existing persona-only patch; prompt/child source tests | Equivalent persona semantics |
| 010 | Native instruction plugin lacks exclusive candidate selection | rebase | Existing plugin options; instruction source and packed tests | Equivalent selection/touch behavior |
| 011 | Structured Provider blocks/replay incomplete | rebase | Existing DSH and separately pinned pi-ai seam; conversion/route tests | Equivalent preserved content/replay |
| 012 | Official executors exist; public factory/edit-preview/publication hooks incomplete | reduce | Existing official file execution with product policy/checkpoints; source and packed files | Equivalent public hooks |
| 013 | Dynamic PromptContext lacks literal selection | rebase | Existing narrow flag; prompt source and Host context tests | Equivalent literal context |

Patch count changes from 10 to 11. New ordered patch-series prefix is `56bce4eb7e07`;
required package count changes from 104 to 105 for native JSONL. Exact full digests and version
identities are generated in the seam registry and accepted artifact manifest. Old manifests prove
only old bytes. New artifact construction compares two independent pack passes and compiles an
isolated consumer; Runtime, platform evidence and Host handoff must be rebuilt afterward.

Default tests use isolated fake Sessions and temporary homes. They verify live buffer retry,
closed-handle refusal, immutable input, native fork markers, retained rewind source, file recovery,
unknown required refusal without changing bytes, and corrupted native prefix rejection. Native
platform claims remain pending unless the corresponding campaign actually runs.

## Product branch acceptance

Live operation, permission and plan folds use the official `Session.isOwnSeq` scope, including
rewind/fork inside inherited history. Cold boundary materialization preserves one canonical boundary
per turn and retains earlier inherited turns; the selected final boundary includes the complete fork
receipt. Regression coverage includes successful inherited replies, nested/early inherited forks,
rewound prefix ownership, owned invalid terminals, independent rules/plans and cold boundary inventory.
Cold repeated-rewind tests additionally retain file/directory checkpoints through the existing
committed generation lineage, exclude discarded future changes, and preserve those records in a
subsequent fork. Final source gates pass typecheck, lint, build and 825 tests (2 platform/capability skips).
The unchanged patched upstream source suite passes 1,106 tests (3 skips); native ownership tests and
fresh packed composition/installed-process gates additionally bind the rebuilt handoff.

`session/read` exports the required native inherited count on every page. The exact response budget
includes it; both shared and browser readers reject changed/out-of-range cuts. Host recovery retains
copied source Product rows and queries/reconciles only target-owned execution. No receipt/marker
heuristic or compatibility fallback replaces native ownership.
