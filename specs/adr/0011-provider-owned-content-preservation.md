# ADR 0011 — Preserve Provider-owned structured content without executing it

Candidate disposition (2026-09-12, U15-W02): Rebase DSH provider content and pi-ai 0.85.1 transport while preserving requested versus response model replay identities and non-executable provider blocks. The isolated source and package checks pass; final product acceptance remains pending in [the upgrade PRD](../prd/prd_0.3_myagents_dsh_0_1_5_upgrade.md). Earlier evidence below applies to its original bytes.

- Status: accepted
- Date: 2026-09-03
- Scope: `B3-XR-PST`, `PST-W3`

Historical disposition (2026-09-03): retained as `DSH-SEAM-011` / patch 0010, paired with the pinned `pi-ai` patch authority under `specs/pi-ai/`.

Self-test correction (2026-09-05): the same pi-ai seam also retains generic `tool_result` when
its ID belongs to an observed server/MCP call in that response. Tool naming and opaque result
envelopes do not gate preservation. Unrelated/client results are never promoted to Provider
activity. The upstream revision and DSH patch remain pinned; updated isolated pi-ai source/build/SSE
evidence passes, while replacement Runtime/platform/handoff acceptance remains open.

## Context

Anthropic Messages-compatible Providers can emit server-side tool call/result content such as Web Search. The pinned `pi-ai` adapter discards those typed blocks, while DSH can durably assemble unknown complete content blocks but must never execute Provider-owned activity through `ctx.tools`.

## Decision

Preserve generic Provider call/result blocks in the pinned `pi-ai` Anthropic adapter, including their exact raw Provider payload for matching-route replay. Extend only DSH's public `ContentBlockMap` and the stock `llm-pi-ai` stream/replay conversion. Provider blocks are non-executable content; canonical local tool calls retain the existing `tool-call` type and sole DSH execution path.

Runtime projects the durable blocks through the distinct `provider_tool` protocol family. The Host may render and persist them, but cannot treat them as local tool approval, policy, Hook, or execution events.

## Consequences

- Provider WebSearch retains structured activity instead of Markdown-like text.
- The design is Provider- and tool-name-neutral across admitted Anthropic Messages routes.
- Replay is exact only for the same native pi-ai route; cross-route translation does not leak Provider-native blocks.
- Both the pinned `pi-ai` package and DSH adapter patches must be rebuilt, content-addressed, and bound into new Runtime/platform/handoff evidence.

## Rejected alternatives

- infer Provider tools from rendered Markdown;
- manufacture canonical `tool/call` and `tool/result` events;
- add another AgentLoop or tool runtime;
- fork or rewrite the complete DSH pi-ai adapter.
