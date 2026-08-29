# ADR 0007 — Preserve established DeepSeek stream tool identities

Status: accepted for the fixed DSH `0.1.1-rc.2` source baseline

Current disposition (2026-08-29): retained as `DSH-SEAM-007` / patch 0006 in the current seven-patch artifact.

## Context

The sanctioned Batch 1 production route uses the official DeepSeek adapter with
`deepseek-v4-flash`. The exact pinned adapter stores every streamed
`tool_calls` delta's `id` and `function.name` by assignment. Current
DeepSeek V4-Flash streams can repeat those fields as empty strings on later
argument deltas, erasing the established identity and producing
`unknown tool ""`. An empty call identity can also make later persisted
Session material unreadable.

The wire contract already states that a call id and name are present on the
first delta and that later deltas carry argument fragments. Product
composition cannot repair an identity after the DSH adapter has emitted the
corrupted tool call, and replacing the official adapter would create a second
Provider implementation.

## Decision

Patch the stock DeepSeek stream translator to accept only non-empty string
updates for call id and tool name. Preserve the existing assignment semantics
for valid non-empty values and the existing argument-fragment concatenation.
Do not relax Session validation or add a product-side repair path.

The patch adds a source-level regression that reproduces one established tool
identity followed by an empty-id/empty-name continuation and proves that every
emitted delta plus the final block retains the original id and name.

## Consequences and removal

The official Runtime remains on one DSH DeepSeek adapter and one DSH
`ctx.tools` pipeline. The change is two guarded assignments plus one focused
test, with no new service, state owner, or compatibility layer.

Remove the patch when an installed DSH release preserves established tool
identities across empty continuation fields and the same translator regression
passes unchanged.
