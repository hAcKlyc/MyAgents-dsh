# ADR 0002 — Authoritative pre-assistant-commit waterfall

Status: accepted on 2026-08-16 for the fixed DSH source baseline

## Context

Stock DSH appends `assistant/message` before parsing and dispatching its tool calls. A later `tools/pre-execute` replacement can change execution input but cannot change durable assistant history. That would make replay, audit, UI, permission, and execution disagree.

## Evidence

The permanent fixture and patched-source suite transform two real AgentLoop calls in model order, validate the full batch before append, and prove that the same canonical argument strings reach `assistant/message`, `tool/call`, permission, execution, result correlation, final presentation, and resumed derived history. Hook denial, timeout, crash, invalid transformed JSON, and cancellation append no authoritative assistant/tool identity. The no-listener case preserves the original call, and an in-flight preparation retains its selected component revision across real listener replacement. Raw `assistant/chunk` events remain model-output provenance; they are not execution input or the authoritative tool/UI projection.

Patch `specs/dsh/patches/0002-pre-assistant-commit.patch` applies after ADR 0001's patch to `deepseek-harness@47f943859bef60e4160492346772ded9b24f765a`; its digest, order, public types, scoped-event catalog update, and real AgentLoop regression suite are fixed in `seam-decisions-v1.json`.

## Decision

Add one Agent-scoped waterfall after stream assembly and before `assistant/message` append, but only when the response contains tool calls that DSH will dispatch. Text-only and `max-tokens` responses retain the original assistant commit and never enter this tool-input authority. Its public value is a `PreparedAssistantCommit` containing the immutable assistant message and ordered parsed tool calls. DSH validates the returned plan, permits only arguments to change for existing call IDs/names, rejects extra own keys/accessors at the message, source, content-block, and prepared-plan levels, preserves non-tool content and provenance, requires changed input to be lossless JSON, and canonically rebuilds both the durable message and scheduler input from the original response plus validated argument replacements.

All calls are prepared before any call is appended or dispatched. Product schema validation and Host `PreToolUse` ordering run inside this boundary; permission and hard guards remain in the single DSH `ctx.tools` pipeline.

## Rejected alternatives

- Rewrite only `ToolExecution.arguments`: durable model history remains false.
- Proxy every tool or dispatch an inner call: creates a second identity and split audit trail.
- Move tool execution outside DSH: creates another tool runtime.

## Consequences and removal

The waterfall is a narrow upstream patch, not a product AgentLoop. The official profile remains inactive until the patched artifact and complete Batch 1 tests pass. Remove it after an installed DSH release exposes an equivalent tested seam. Supersession requires the full atomicity, replay, repair, cancellation, HMR, and no-listener matrix.
