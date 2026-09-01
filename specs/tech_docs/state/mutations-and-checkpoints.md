---
type: technical-architecture
status: implemented
module: mutations-and-checkpoints
updated: 2026-09-02
product_scope: ../../prd/prd_0.1_agent_runtime.md
implementation_decision: ../../prd/tech_rfc_0.1_session_persistence_mutations.md
decision: ../../adr/0004-shared-backend-lock-and-immutable-rewind-generation.md
---

# Mutations and checkpoints

## 1. Purpose and authority

This guide explains fork, rewind, delete and governed file restoration. Durable conversation
mutation stays inside the DSH Session/persistence authority; Product services coordinate the
business transaction without creating another transcript. Exact RPC shapes live in the protocol
source.

## 2. Relationships

- **Owns:** prepare/commit/status/rollback-or-abort transaction state, mutation tokens, source/postcondition validation, locator publication, tombstones and governed checkpoint coordination.
- **Depends on:** quiescent primary Session, stable read boundaries, shared persistence lock, operation/work drainage and canonical file identity.
- **Consumed by:** Host fork/rewind/delete UX, recovery flows, Session catalog updates and artifact acceptance campaigns.
- **Does not own:** ordinary conversation append, shell/external rollback, UI retry semantics, arbitrary filesystem snapshots or Host catalog deletion.

## 3. Owners

| Owner | Responsibility |
| --- | --- |
| Host | user confirmation/boundary choice, one durable external mutation journal per source Session, fork target catalog/control and catalog removal only after Runtime success |
| ProductSession Runtime | RPC admission, root lifecycle/quiescence, generation replacement/resume and mutation orchestration |
| `persistence-product` | SQLite journals/tokens, boundaries, generations, tombstones, checkpoint rows/content-addressed preimage blobs and rewind file plans |
| `checkpoint` | checkpoint state machine, DSH event correlation and restore coordination |
| `tools-fs` | canonical path/precondition checks, file capture and temporary-file-plus-rename restore I/O |
| DSH | sole Session event log, derived conversation and Agent lifecycle |

## 4. Operation-specific transaction model

Fork, rewind and delete expose prepare plus explicit settlement with immutable operation tokens.
The commit wire request carries `token` and `clientMutationId`; prepare freezes the postcondition
that the Store rechecks. Their legal phases differ:

| Mutation | Publication and internal phases | Reversal |
| --- | --- | --- |
| rewind | prepared → committing → committed; new generation/locator and rewind receipt | rollback may undo prepared or committed state through rolling_back |
| delete | prepared → committing → committed tombstone; optional later `purge` | rollback may undo a non-purged prepared or committed delete |
| fork | source prepared → committing; idempotently activate target Store; source committed | abort only before commit, through aborting; committed fork is independent and not rollbackable |

`status` reads the journal to recover response loss. Revalidation is operation-specific rather than
one common checklist: fork waits for root Agent idle and rechecks source locator/revision/boundary;
rewind and delete retire the generation and drain ProductWork/jobs; only rewind owns transcript
postconditions, excluded-child plans and governed-file hashes. Wire results may fold internal
`committing`, `rolling_back` or `aborting` phases into their public status vocabulary.

## 5. Rewind

Rewind selects one exact completed-turn boundary or the materialized genesis boundary. It creates a
new active generation containing the stable DSH prefix plus one durable
`myagents/session/rewind` receipt; the old generation becomes archived. Direct children and
descendants born after the boundary are tombstoned/archived and can be restored by rollback.

File plans use only settled checkpoints after the boundary and require strict hash continuity for
each path. Manual/untracked gaps or external drift produce conflict. Each file checkpoint is capped
at 8 MiB. Coverage still excludes shell, child and external changes.

One current crash-safety gap must remain visible: file restore occurs before its file plan is marked
published, and all files are published before the main SQLite rewind journal advances from
`prepared` to `committing`. A process crash in that interval can leave restored files while later
rollback marks the main mutation rolled back, or can make commit replay conflict with changed
source hashes. Existing tests cover ordered execution and in-process compensation, not every
cross-filesystem/SQLite crash point. Conversation locator publication itself remains transactional;
the broader "no half-rewound files" claim is not currently valid.

## 6. Fork

Fork publishes a new independent Session identity from a selected stable source prefix. Target and
source must use the same Workspace identity; target `runtimeHome` must not overlap the source and
its Store may not already contain another Session. The target receives the stable source prefix,
one `myagents/session/fork` receipt, and only settled checkpoint rows/blobs inside the boundary. It
does not copy the child Session graph or Workspace files, and both Sessions still point at the same
Workspace. The source Agent is not retired; commit waits only for root idle.

Fork is a recoverable phased cross-Store commit, not one atomic SQLite transaction: the source
journal reaches `committing`, target activation is idempotent, then the source journal becomes
`committed`. The Host owns target process/catalog orchestration around that durable convergence.

## 7. Delete

Delete tombstones the current Runtime Session locator and active generation; "Session graph" here
means this Session's SQLite relation graph, not ProductWork child Session lineage. A committed,
non-purged delete can roll back. Optional purge removes this Session's
generations/events/boundaries/checkpoints/source mutation journals and garbage-collects checkpoint
blobs no longer referenced anywhere in the database; purge is not rollbackable. It does not delete
Workspace files, child lineage or the Host catalog. The Host removes its catalog entry only after
Runtime purge success.

## 8. Checkpoint coverage and limits

The current rollback claim is deliberately narrow: root-origin governed canonical `Write` and `Edit` calls. It excludes Bash, child agents, MCP/Host tools, external processes, ungoverned files and modifications outside the recorded tool preimage. Child file calls still receive normal permission/policy but are not checkpoint-covered.

This boundary must be visible to Hosts. Expanding it requires a concrete side-effect owner and journal/compensation semantics; a directory snapshot or marketing label cannot silently broaden the claim.

## 9. Recovery behavior

While a Session is `recovery_required`, normal work is fenced. The current prepare-admission gate
only requires the requested mutation **kind** (`delete`, `fork` or `rewind`) to match one unsettled
kind; it does not compare the original `clientMutationId`, token or request fingerprint. The Store
then uses token/`clientMutationId` for concrete journal settlement and enforces at most 64 pending
mutations, but a new id of the same kind can create another journal. Therefore the stronger
"only the exact prepared request can be replayed" invariant is not implemented today.

The Reference Web Host separately persists one external mutation authority per source Session and
uses Runtime status to recover response loss. That Host journal is business orchestration, not a
second conversation transaction. A future Runtime fix for exact recovery admission must carry and
compare the journal identity/fingerprint rather than relying on kind alone.

## 10. Architecture-correct change path

Add a mutation only when its source boundary, candidate, external side effects, operation-specific
commit point and crash recovery can be stated exactly. Reuse the shared Store authority and
prepare/settle/status pattern without pretending cross-Store or filesystem/SQLite work is one atomic
transaction. For new rollback coverage, define the executing owner, preimage format, idempotent
restore and irrecoverable-failure behavior before changing claims. The two known gaps above require
exact-journal admission tests and process-crash tests between every file-plan/main-journal boundary
before stronger recovery claims are restored.

## 11. Verification and implementation map

| Concern | Source or evidence |
| --- | --- |
| Mutation coordination and RPC binding | `packages/runtime-product/src/primary-session.ts` |
| Journals/generations/tombstones | `packages/persistence-product/src/` |
| Checkpoint coordination | `packages/checkpoint/src/` |
| File capture/restore I/O | `packages/tools-fs/src/local-filesystem.ts` |
| Host mutation journal/orchestration | `packages/web-host/src/mutation-store.ts`, `reference-profile.ts` |
| Exact mutation shapes | `packages/protocol/src/contract-source.ts` |
| Tests | `tests/product-persistence.unit.test.ts`, `tests/product-checkpoint.unit.test.ts`, `tests/primary-session-admission.unit.test.ts`, `tests/web-host-mutation-store.unit.test.ts`, `tests/web-host-reference-profile.unit.test.ts` and packed campaigns; current tests do not cover the documented rewind crash window |
