# ADR 0002 — Authoritative pre-assistant-commit waterfall

RC3 refresh (2026-09-23): see the [complete seam adjudication](../dsh/upstream-refresh-2026-09-23.md). Official rc.3 adds no runtime/public-seam behavior; the current registry preserves this decision and its removal condition. Historical evidence below remains bound to its original bytes.

Candidate disposition (2026-09-12, U15-W02): Reduce the patch by dropping upstream-owned util-values wiring; govern the assembled tool arguments before native settlement while preserving the original stream. The isolated source and package checks pass; final product acceptance remains pending in [the upgrade PRD](../prd/prd_0.3_myagents_dsh_0_1_5_upgrade.md). Earlier evidence below applies to its original bytes.

Status: accepted on 2026-08-16 for the fixed DSH source baseline

Historical disposition (2026-08-29): retained and rebased as `DSH-SEAM-002` / patch 0002 for official DSH `0.1.1-rc.2`. The current seam registry and upstream refresh records supersede the original rc.5 patch identity below.

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
