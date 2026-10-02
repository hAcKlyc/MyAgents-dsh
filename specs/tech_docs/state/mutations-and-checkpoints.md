---
type: technical-architecture
status: implemented
module: mutations-and-checkpoints
updated: 2026-10-02
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
| `persistence-product` | SQLite journals/tokens, boundaries, generation locators, tombstones, checkpoint rows/content-addressed preimage blobs and rewind file plans |
| `checkpoint` | checkpoint state machine, DSH event correlation and restore coordination |
| `tools-fs` | canonical path/precondition checks, file capture and temporary-file-plus-rename restore I/O |
| DSH | official JSONL event log and physical handles, native fork seed, derived conversation and Agent lifecycle |

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
rewind and delete retire the generation and drain native subagents/jobs; only rewind owns transcript
postconditions, excluded-child plans and governed-file hashes. Wire results may fold internal
`committing`, `rolling_back` or `aborting` phases into their public status vocabulary.

## 5. Rewind

Rewind selects one exact completed-turn boundary or the materialized genesis boundary. It creates a
new active generation containing the stable DSH prefix plus one durable
`myagents/session/rewind` receipt; the old generation becomes archived. Direct children and
descendants born after the boundary are tombstoned/archived and can be restored by rollback.

When a selected prefix ends inside inherited history, it excludes the generation's inherited
end-seed marker. Rewind uses official `buildForkSeed` to complete that native seed before appending
the Product receipt; the inherited cut and selected stable-prefix postcondition remain exact.
Prefixes already containing their native marker are retained unchanged. Cold JSONL decoding is
part of the regression, so a hash-valid but structurally invalid candidate cannot pass acceptance.

Official JSONL create/append/flush completes the candidate before the locator transaction.
The journal's timestamp makes candidate bytes deterministic across retries. A crash before locator
publication leaves the source authoritative; retry validates the candidate and completes the same
switch. A complete candidate is reused. A partial or corrupt unpublished candidate may be removed
and reseeded through native persistence while holding the mutation lease; an active generation is
never eligible for this recovery. Rollback selects the retained source log. No Session event bytes
are copied into SQLite.

File plans use only settled checkpoints after the boundary and require strict hash continuity for
each path. Manual/untracked gaps or external drift produce conflict. Each file checkpoint is capped
at 8 MiB. Coverage still excludes shell, child and external changes.

File publication and SQLite phase updates are separate durable operations. Replay now captures each
file and accepts only the sealed source or target hash (including recorded absence). Commit finishes
a target already published before a crash; rollback restores an unjournaled publication even while
the main mutation remains `prepared`. An unrelated hash fences the operation. After all target files
settle, cleanup processes directory plans deepest first. Rollback restores journaled removed parents
before restoring file bytes and records replacement inode receipts before proceeding. Conversation
locator publication remains a separate SQLite transaction; no cross-filesystem atomicity is claimed.
Source tests exercise both file-plan phase gaps and interrupted directory-removal receipts. Native
process-crash/platform acceptance must be bound to the final Runtime artifact.

## 6. Fork

Fork publishes a new independent Session identity from a selected stable source prefix. Target and
source must use the same Workspace identity; target `runtimeHome` must not overlap the source and
its Store may not already contain another Session. The target receives the stable source prefix,
one `myagents/session/fork` receipt, and only settled checkpoint rows/blobs inside the boundary. It
does not copy the child Session graph or Workspace files, and both Sessions still point at the same
Workspace. The source Agent is not retired; commit waits only for root idle. Native `buildForkSeed` appends the inherited marker and any required native closers before the product receipt. The exact inherited cut excludes those native suffix facts.

The target's initial stable boundary includes its complete seed and fork receipt, preserving the
lineage when it is forked again. Cold boundary materialization keeps that canonical boundary for its
turn and materializes earlier inherited turns normally. Each turn has one stable boundary, so all
retained history remains available for rewind and fork without duplicate target boundaries.

Fork is a recoverable phased cross-Store commit, not one atomic SQLite transaction: the source
journal reaches `committing`, target activation is idempotent, then the source journal becomes
`committed`. The Host owns target process/catalog orchestration around that durable convergence.

## 7. Delete

Delete tombstones the current Runtime Session locator and active generation; "Session graph" here
means this Session's SQLite relation graph, not native child Session lineage. A committed,
non-purged delete can roll back. Optional purge removes this Session's
native generation directories and product boundaries/checkpoints/source mutation journals and garbage-collects checkpoint
blobs no longer referenced anywhere in the database; purge is not rollbackable. The durable purge receipt retains the generation ids so native-directory cleanup can repeat after a crash or response loss. It does not delete
Workspace files, child lineage or the Host catalog. The Host removes its catalog entry only after
Runtime purge success.

## 8. Checkpoint coverage and limits

The root rewind claim covers governed canonical `Write` and `Edit` only. Concurrent independent
`Edit` calls serialize at publication and capture each current preimage in that lock, so their
checkpoint hashes form a continuous chain. An approved literal edit may retain unrelated changes;
changed match counts or overlapping edits require a new Read/Edit request, and publication still
uses a version precondition. It excludes Bash, child
files, MCP/Host tools, external processes and unrecorded preimages. New-file child `Write` now uses the same
checkpoint service and SQLite tables internally, keyed by the child Session, to govern parent creation
and abort/crash cleanup; root rewind queries select the root Session only and child results carry no
root checkpoint receipt. This does not extend the root file rollback claim.

The current coordination schema stores an optional directory plan in checkpoint records. No old development schema migration runs. Plans contain at most 64 missing parents under an existing canonical
anchor. Each entry advances through `planned`, `created`, `removing`, `removed` and (on rollback)
`restoring`, retaining exact directory identities. The immutable checkpoint/DSH event correlation
continues to own the file operation. A fork copies recorded checkpoint directory facts with its
checkpoint preimages; it does not infer ownership from the current workspace.

The plan is persisted before mkdir; an inode receipt is persisted before the next mkdir or file
publication. Cleanup uses non-recursive rmdir only for a recorded, unchanged, empty directory.
New-file canonical Writes take a workspace-scoped publication lock before checkpoint preparation
and hold it through settlement. This prevents two same-message Writes from planning overlapping
missing parents before the first directory creation receipt is durable. Existing-file Writes keep
their per-target lock.
External files keep their containing directories intact. Replaced directories are retained. A crash
or storage failure after mkdir but before its inode receipt can leave an empty planned directory:
its ownership is unproven, so recovery retains it and never adopts its identity to authorize file
publication or deletion. A restoration in that uncertain window fences further compensation.
Cancellation records cleanup through an independent signal. Primary and child Agents reconcile
unsettled checkpoint facts before their first model step. Checkpoint lineage reads only the Session owned event suffix: a native fork keeps inherited parent checkpoints in its conversation history without adopting their file recovery authority. The identity check still rejects mismatched records in the owned suffix; checkpoint prepare also enforces recovery
before a resumed tool can mutate files.

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
restore and irrecoverable-failure behavior before changing claims. Exact-journal admission and process-crash campaigns must remain acceptance gates; source hash adjudication does not replace final-artifact evidence.

## 11. Verification and implementation map

| Concern | Source or evidence |
| --- | --- |
| Mutation coordination and RPC binding | `packages/runtime-product/src/primary-session.ts` |
| Journals/generations/tombstones | `packages/persistence-product/src/` |
| Checkpoint coordination | `packages/checkpoint/src/` |
| File capture/restore I/O | `packages/tools-fs/src/local-filesystem.ts` |
| Host mutation journal/orchestration | `packages/web-host/src/mutation-store.ts`, `reference-profile.ts` |
| Exact mutation shapes | `packages/protocol/src/contract-source.ts` |
| Tests | `tests/product-persistence.unit.test.ts`, `tests/product-checkpoint.unit.test.ts`, `tests/primary-session-admission.unit.test.ts`, `tests/web-host-mutation-store.unit.test.ts`, `tests/web-host-reference-profile.unit.test.ts` and packed campaigns; source tests cover unjournaled file publication and interrupted directory cleanup |
