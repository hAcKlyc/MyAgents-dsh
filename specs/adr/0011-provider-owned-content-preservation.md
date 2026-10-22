# ADR 0011 — Preserve Provider-owned structured content without executing it

Current DSH `0.2.1-rc.2` disposition (2026-10-23): rebased as patch 0010 with the separately pinned pi-ai `1.1.0` Provider-content patch. The [DSH seam registry](../dsh/seam-decisions-v1.json) and [pi-ai source authority](../pi-ai/seam-evidence-v1.json) own exact source, blob and ordered patch identities. Candidate `0.1.19` requires fresh artifact, native and Host evidence; dated evidence below is historical.

- Status: accepted
- Date: 2026-09-03
- Scope: `B3-XR-PST`, `PST-W3`

Historical disposition (2026-09-03): retained as `DSH-SEAM-011` / patch 0010, paired with the pinned `pi-ai` patch authority under `specs/pi-ai/`.

Historical self-test correction (2026-09-05): the same pi-ai seam also retains generic `tool_result` when
its ID belongs to an observed server/MCP call in that response. Tool naming and opaque result
envelopes do not gate preservation. Unrelated/client results are never promoted to Provider
activity. The upstream revision and DSH patch remain pinned; updated isolated pi-ai source/build/SSE
evidence passes, while replacement Runtime/platform/handoff acceptance remains open.

## Context

Anthropic Messages-compatible Providers can emit server-side tool call/result content such as Web Search. The pinned `pi-ai` adapter discards those typed blocks, while DSH can durably assemble unknown complete content blocks but must never execute Provider-owned activity through `ctx.tools`.

## Decision

Preserve generic Provider call/result blocks in the pinned `pi-ai` Anthropic adapter, including their exact raw Provider payload for matching-route replay. Extend only DSH's public `ContentBlockMap` and the stock `llm-pi-ai` stream/replay conversion. Provider blocks are non-executable content; canonical local tool calls retain the existing `tool-call` type and sole DSH execution path.

Runtime projects the durable blocks through the distinct `provider_tool` protocol family. The Host may render and persist them, but cannot treat them as local tool approval, policy, Hook, or execution events.

The `1.1.0` rebase retains generic server/MCP call correlation, opaque Provider payloads,
requested/response model distinctions and matching-route replay through current native pi-ai
types. The second pi-ai source patch independently ports DSH's official optimization that defers
streamed client-tool argument parsing until terminal edges. It preserves delta text and final
arguments; it neither changes Provider-owned content admission nor grants local execution authority.

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
