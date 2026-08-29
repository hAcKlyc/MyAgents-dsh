# ADR 0003 — Frozen predicate for required product Session events

Status: accepted on 2026-08-16 for the fixed DSH source baseline

## Context

MyAgents operation, TaskGraph, work, permission, checkpoint, and mutation facts are required DSH Session events. Stock `PersistenceCoordinator` accepts only its monorepo-generated event set when it loads, inspects, prepares, resumes, or adopts a live prefix. Marking product facts ignorable would permit a reader to reconstruct an incorrect operation or mutation state.

## Evidence

The patched-source suite appends a declaration-merged required product event, then exercises live append, inspect, cached prepare, cold load, coordinator replacement/adoption, default-option refusal, and an unregistered-required-event refusal through the real `PersistenceCoordinator`. The root fixture independently checks the exact frozen product union. `npm run check:dsh-seams-source` compiles and runs this matrix at the exact fixed source.

Patch `specs/dsh/patches/0003-persistence-known-event-predicate.patch` is the third pinned patch over `deepseek-harness@47f943859bef60e4160492346772ded9b24f765a`.

## Decision

Add optional `PersistenceCoordinatorOptions.isKnownEventType`. Omission delegates exactly to `KNOWN_SESSION_EVENT_TYPES.has(type)`. The official product Provider passes one frozen generated predicate containing stock and exact required product event names. Unknown non-ignorable events continue to fail closed through every existing coordinator read path.

## Rejected alternatives

- Set `ignorable: true` on recovery-critical facts.
- Mutate or import the private generated known-event set.
- Reimplement coordinator orchestration before a narrower seam is tried.

## Consequences and removal

The option changes recognition policy, not storage format or Session authority. Event registration cannot change at HMR time. Remove the patch after an installed DSH release supplies equivalent build-level registration and all load/inspect/prepare/resume/adoption refusal fixtures pass.
