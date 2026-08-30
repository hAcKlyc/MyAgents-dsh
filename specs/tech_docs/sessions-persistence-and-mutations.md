---
type: technical-architecture
status: implemented
module: sessions-persistence-and-mutations
updated: 2026-08-31
product_scope: ../prd/prd_0.1_agent_runtime.md
implementation_decision: ../prd/tech_rfc_0.1_session_persistence_mutations.md
decisions:
  - ../adr/0003-product-session-event-predicate.md
  - ../adr/0004-shared-backend-lock-and-immutable-rewind-generation.md
---

# Sessions, persistence and mutations

## 1. Authority

DSH Session events are the only durable model-conversation log. MyAgents product events declaration-merge into that vocabulary; SQLite stores the same authoritative event sequence and mutation journals, not a shadow transcript.

`packages/runtime-product/src/primary-session.ts` owns the one-primary-Session product boundary. `packages/persistence-product/` owns the production DSH PersistenceBackend, known-event admission, reads, compaction receipts, mutation transactions, and SQLite schema. `packages/checkpoint/` owns governed root `Write`/`Edit` preimages.

## 2. Storage model

The current store uses immutable Session storage generations plus an active locator. Ordinary events append to one generation under the shared per-Session lock. Required product events are admitted through the exact known-event predicate; unknown non-ignorable events fail closed.

Cold load validates sequence, hashes, revisions, event vocabulary, and fold invariants before materializing an Agent. Cached preparation never becomes a second durable authority.

## 3. Lifecycle and recovery

Create publishes a fresh Session only after root admission. Resume inspects and repairs permitted incomplete operation facts, reconstructs product folds, and starts the DSH Agent over the active generation. Read returns bounded engine-neutral durable projections with stable cursors, completed-turn mutation boundaries, and one optional genesis boundary for the exact prefix before the first product operation. Close drains persistence and retires the Agent/Session without deleting history.

Crash recovery appends or resumes explicit product settlement where allowed. It does not silently truncate valid effects or infer success from an idle process. Recovery-only operations remain fenced to the exact incomplete transaction. While resume is `recovery_required`, an exact replay of the already prepared delete/fork/rewind request is accepted solely to recover its durable token/result; the persistence fingerprint and pending-mutation capacity reject a different request.

## 4. Mutations

Rewind, fork and delete use prepare/commit/status/rollback-or-abort protocols with immutable operation tokens and exact source revisions.

- Rewind publishes a new generation from one stable DSH prefix, restores only governed file state, and switches the locator atomically. Its target may be a completed-turn boundary or the materialized genesis boundary; genesis permits an admitted first turn to be removed without inventing an empty-history assumption.
- Fork publishes an independent Session identity from the selected stable prefix.
- Delete publishes a recoverable tombstone; purge later removes only the exact committed graph and unreferenced checkpoint blobs.

No mutation rewrites the source generation. Every delayed boundary revalidates locator, revision, Session identity, child/work ownership, transcript postcondition, and managed-file hashes. Genesis is excluded from the ordinary latest-completed-boundary calculation and is accepted only through its exact opaque identity, sequence and postcondition.

## 5. Compaction relationship

Compaction is a DSH durable Session transaction, not a storage mutation implemented by SQLite. `persistence-product/src/compaction.ts` correlates explicit product operations and receipts around the DSH engine. Automatic strategy and patch ownership are documented in [Compaction architecture](./compaction-architecture.md).

## 6. Rollback coverage

The current rollback claim covers only root-origin governed `Write` and `Edit`. Shell, child agents, MCP, Host tools, external processes, and ungoverned files remain outside coverage. Any expansion needs a new owner, exact journal semantics, and failure campaigns.

## 7. Change rules

Schema, event, fold, generation, or mutation changes require migration/fault tests, crash-point idempotency, installed-artifact campaigns, and updated protocol/profile evidence. RPC handlers never receive raw SQLite authority.
