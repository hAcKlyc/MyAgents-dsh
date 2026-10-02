# ADR 0003 — Required product events through the official JSONL validation seam

Status: accepted; updated 2026-10-02 for DSH `0.2.0-rc.2`.

## Context

Operation, permission, work, checkpoint and mutation facts are required DSH Session events.
Official JSONL owns storage and native restoration, but its default vocabulary excludes these
build-time product declarations. The public native validator cannot register them, and marking
recovery facts ignorable would permit incorrect restoration. Replacing the JSONL backend or
mutating the native known-event set would duplicate an upstream owner.

## Decision

Reduce seam 003 to one protected `JsonlSessionPersistence.validateStoredEvents` hook. Its default
calls the unchanged native validator. The trusted product subclass composes that validator with
the exact frozen product registry and each owner's payload validator. Native codec, physical
layout, leases, buffering, append, flush, close and recovery remain upstream implementations.
No historical PersistenceCoordinator, predicate option or SQLite Session backend remains.

The [seam registry](../dsh/seam-decisions-v1.json) owns exact source/blob/patch identities. Public
compile evidence checks the protected override. The official current-event-admission and lease
source suites retain stock refusal semantics. Product handle, persistence and checkpoint tests
exercise cold native JSONL restore, malformed known payloads, unknown required/ignorable events,
immutable inputs, live barriers and native final-drain failures.

## Removal condition

Remove the hook patch when an installed official JSONL release supplies equivalent trusted
extension validation and those regressions pass. Required facts must remain required; there is
no product codec or second event log to preserve.
