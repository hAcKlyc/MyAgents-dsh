# ADR 0004 — Shared backend lock and immutable rewind generation

Status: accepted on 2026-08-16 as the Batch 1 persistence composition

Current disposition (2026-08-29): implemented through the public DSH PersistenceBackend plus the product-owned SQLite mutation companion as `DSH-SEAM-004`; no DSH core patch is carried for this decision.

## Context

The public DSH persistence seam supports append, load, inspect, prepare, and revision observation, but product delete/fork/rewind needs explicit transaction preconditions. Rewind cannot hide later events only at the surface: those events would remain authoritative for operation, work, permission, and checkpoint folds.

## Evidence

The permanent fixture implements the public DSH `PersistenceBackend` contract and serializes ordinary backend append and companion mutation commit through one per-Session lock. Retirement drains an already-admitted append; a mutation waiting behind it observes a changed revision and fails. Cached preparation is invalidated, abort while waiting commits nothing, and a fresh exact revision publishes a new storage generation. Cold inspection of that generation preserves the exact stable prefix, product-event fold, and `deriveMessages()`, retains the source generation unchanged, and adds no placeholder surface node. Its delete companion requires a retired writer, stable `turn/end` boundary, and unchanged revision; it publishes a recoverable tombstone, refuses conflicting identities, and returns `already_deleted` with the same tombstone revision after response loss.

## Decision

Batch 1 will implement one MyAgents SQLite `PersistenceBackend` and a mutation companion over the same storage owner and abortable per-Session lock. Prepare is non-publishing. A locator-changing commit requires closed admission, settled/cancelled owned work, disposed Agent/Session, drained persistence retirement, a cold inspect, and an unchanged source-qualified revision.

Rewind creates a new immutable storage generation from the exact stable prefix and atomically switches the active locator. Fork uses the same prefix publication under a new Session identity. Delete uses a recoverable tombstone before later purge. DSH Session events remain the only model-conversation and product-event log.

## Rejected alternatives

- Surface replacement or placeholder messages as rewind.
- Direct SQLite access from RPC handlers.
- Private DSH storage imports.
- Simultaneous JSONL and SQLite production authorities in Batch 1.

## Consequences and supersession

This ADR accepts a public Provider composition; it does not implement the production backend during Pre-Batch. Workstream 4 still owes SQLite DDL, crash journals, fsync behavior, native evidence, and fault tests. Supersession requires equivalent generation, revision, lock, and crash semantics with no second transcript.
