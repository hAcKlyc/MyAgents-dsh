# ADR 0004 — Native JSONL generations and product mutation coordination

Status: accepted; supersedes the unreleased SQLite Session backend on 2026-10-02.

## Context

DSH `0.2.0-rc.2` provides native JSONL Session handles and physical leases, but no product
rewind/fork/delete transaction or governed-file restoration API. These product operations must
remain available without storing a second transcript or copying native persistence logic.

## Decision

`ProductJsonlSessionPersistence` delegates log operations to official JSONL handles. Each product
generation selects a native root; DSH owns every file inside it. Product coordination stores
active locators, revision/hash preconditions, stable boundaries, mutation journals and checkpoint
preimages in `persistence/coordination.sqlite`, current schema 1. There is no event table.

A product locator lease covers the writer lifetime and generation-changing operations. DSH
separately owns its physical write lease. Mutations require retirement/quiescence and exact source
preconditions. Rewind durably seeds a candidate through public native create/append/flush before
atomically switching the product locator; retry validates the same deterministic candidate.
Rollback selects the retained source. Fork uses public `buildForkSeed` to produce the inherited
marker and native closers, then adds the product receipt. Delete tombstones before idempotent
purge; its durable receipt records generation ids for cleanup after process or response loss.

The product metadata store cannot overwrite native history. Native append growth reconciles the
product index; any changed previously durable prefix refuses. No cross-filesystem or cross-store
atomicity is claimed. No old development schema or Session log is migrated.

## Evidence and removal

Product tests cover immutable prefix preservation, repeated settlement, stale source refusal,
writer contention, file/directory phase gaps, native resume, corrupted/unknown histories and
recovery-only classification. Packed Runtime and native ownership evidence are identity-bound.
[Sessions](../tech_docs/state/sessions-persistence-and-recovery.md) and
[Mutations](../tech_docs/state/mutations-and-checkpoints.md) define current owners and limits.

Seam 004 remains public composition without a core patch. Replace product coordination only
when official public mutation APIs satisfy the complete locator, checkpoint, journal and recovery
contract. Do not rebuild DSH's codec, batching, locking or torn-tail recovery in the product.
