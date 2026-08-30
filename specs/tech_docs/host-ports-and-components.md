---
type: technical-architecture
status: implemented
module: host-ports-and-components
updated: 2026-08-29
product_scope: ../prd/prd_0.1_agent_runtime.md
implementation_decision: ../prd/tech_rfc_0.1_host_ports_components.md
---

# Host ports and declarative components

## 1. Purpose

Host ports carry product-owned capabilities across the bidirectional RPC boundary without moving Host authority into the Runtime. Declarative components let a trusted Host describe MCP servers, Skills, agents, commands, Hooks, and Host tools without installing arbitrary JavaScript at Session runtime.

## 2. Reverse-port ownership

`packages/host-ports/src/service.ts` is the sole Runtime reverse-request service. Specialized providers adapt it into DSH-facing services:

- `credential-provider.ts` resolves request- or connection-scoped secrets;
- `attachment-store.ts` acquires, verifies, stages, and releases Host-owned bytes;
- `packages/runtime-product/src/host-interaction.ts` owns permission/question/plan interactions;
- `host-model.ts` and `host-settings.ts` project the admitted non-secret model route;
- `host-web-bridge.ts` supplies governed canonical WebSearch/WebFetch for eligible non-DeepSeek routes.

Secrets never enter Session events, logs, declarative snapshots, settings persistence, or handoff evidence.

## 3. Component generations

`packages/component-runtime/` owns desired/effective snapshots and generation promotion:

```text
validate descriptors and content identities
  -> prepare resources without live registration
  -> compile contribution plans
  -> wait for the required operation boundary
  -> atomically commit one contribution generation
  -> publish effective revision
  -> drain and dispose the previous generation
```

Preparation must not leak a tool, prompt section, listener, transport, or credential into the active Agent scope. Every structurally valid declarative component is an isolated compatibility unit. A missing compiler reports `unsupported`; a prepare failure, non-ready plan, contribution/catalog collision, or locally reversible install failure omits only that component and still permits the remaining generation to become effective. Component receipts preserve kind/id plus a phase-specific reason, and the Host must log non-ready receipts. Snapshot schema/digest/reference ambiguity and failed prepare cleanup or install rollback remain generation failures because the Runtime can no longer prove a clean effective boundary.

## 4. Component packages

| Component | Code authority |
| --- | --- |
| MCP discovery, transport and namespaced tools | `packages/components-mcp/` |
| Skills | `packages/components-skills/` |
| Agent descriptors | `packages/components-agents/` |
| Commands | `packages/components-commands/` |
| Host tools | `packages/components-host-tools/` |
| Pre/Post/Permission Hooks | `packages/components-hooks/` |

Every call revalidates the operation-frozen component generation and relevant policy. Replacement creates a new owned connection/resource set; it does not mutate a live generation in place.

Host Skill source content is never rewritten. Only its effective catalog/provider description is projected for portable discovery: ASCII control/whitespace runs collapse to one space and the value is truncated by Unicode code point to 1,024 characters, matching the open Agent Skills description bound. The effective catalog and DSH Skill provider receive the same projected value.

## 5. Network and attachment safety

MCP and canonical web access use composition-owned network policy, DNS/address checks, origin confinement, redirect policy, byte/concurrency/deadline limits, cancellation, and bounded cleanup. Attachment bytes cross an explicit lease port, become read-only staged files under the composition-selected root, and release once on every success/failure/cancel path. Browser or Host-local backing paths are never projected into the Runtime conversation.

## 6. Change rules

- Ordinary Host input remains declarative; executable plugins are installed only by trusted Runtime builders.
- Add reverse methods in the canonical protocol source and generated client, not as ad hoc transport messages.
- Keep credential scope narrower than component lifetime whenever possible.
- Preserve prepare/commit/drain ownership and prove replacement, rollback, stale response, cancellation, and cleanup behavior.
- Update the compatibility manifest when a new Host capability becomes required for a Provider/tool cell.
