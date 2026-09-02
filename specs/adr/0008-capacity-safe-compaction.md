# ADR 0008 — Keep capacity-safe compaction inside the official DSH engine

- Status: accepted
- Date: 2026-08-29
- Scope: `B1-W4-A11`, `CP-P0-03` through `CP-P0-07`

Current disposition (2026-09-03): retained as `DSH-SEAM-008` / patch 0007 in the current ten-patch artifact and documented by `specs/tech_docs/execution/compaction.md`.

## Context

The pinned basic compaction package exposes only a post-selection summarizer hook. MyAgents-dsh cannot preflight the exact summary envelope or reduce a selected range at balanced boundaries through public APIs. Reimplementing private range/transaction behavior in a product plugin would create a second compaction policy owner and couple the product to private DSH internals.

## Decision

Carry one minimal, ordered, upstream-ready DSH patch. It exposes complete request estimation on the existing singleton `TokenMeter` and strengthens the official `BasicCompactionEngine` with summary-model capacity resolution, balanced fitting, Prompt v2 validation and one repair, content-free telemetry, and multi-call provenance. MyAgents-dsh composes that engine with the official Tool Result Pruner and does not subclass or replace it.

## Consequences

- DSH remains the only range, retry, summary, and durable replacement authority.
- Product code imports only package-root public APIs.
- The patched artifact identity changes and all dependent profile, Runtime, and handoff evidence must be rebuilt.
- The patch is removed when an installed DSH release supplies equivalent executable semantics.

## Rejected alternatives

- duplicate DSH selection/transaction code in MyAgents-dsh;
- estimate summary capacity with an independent Host heuristic;
- accept a known-overflow request and rely on Provider failure;
- omit repair-call provenance or mislabel two calls as exactly one.
