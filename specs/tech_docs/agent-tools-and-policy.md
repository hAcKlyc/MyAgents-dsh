---
type: technical-architecture
status: implemented
module: agent-tools-and-policy
updated: 2026-08-29
product_scope: ../prd/prd_0.1_agent_runtime.md
implementation_decisions:
  - ../prd/tech_rfc_0.1_agent_experience.md
  - ../prd/tech_rfc_0.1_dsh_capability_map.md
---

# Agent tools and policy

## 1. Purpose and authority

This module owns the canonical Agent experience exposed by the official Runtime: tool definitions, visibility, policy, permissions, execution, output, plan/task state, and child/background work. Exact tool schemas and behavior fixtures come from `packages/tool-contracts/src/contract-source.ts` and generated artifacts.

## 2. Single execution pipeline

All model-visible tools register into the one DSH `ctx.tools` registry and execute through one ToolRuntime. A MyAgents compatibility tool may replace a stock DSH definition, but it does not create a parallel tool engine.

```text
visible definition + frozen operation scope
  -> validate original input
  -> governed PreToolUse transform
  -> validate transformed input
  -> workspace / plan / origin hard guards
  -> permission and interaction
  -> bounded DSH ToolRuntime dispatch
  -> canonical output
  -> PostToolUse transform
  -> durable DSH tool result
```

Visibility and permission remain separate. Hiding a tool does not authorize execution, and a visible definition still revalidates workspace, revision, mode, origin, and hard policy at the delayed execution boundary.

The four permission modes, durable exact-rule lifecycle, blocking interaction path and Host-controlled Plan transition are specified in [Permissions and interactions](./permissions-and-interactions.md). This guide owns their placement in the tool pipeline; that guide owns their detailed policy semantics.

## 3. Canonical catalog and owners

The official catalog contains exactly twenty definitions:

```text
Read, Write, Edit, Glob, Grep, Bash, ls,
WebFetch, WebSearch, AskUserQuestion, EnterPlanMode, ExitPlanMode,
Skill, Agent, TaskStop, SendMessage,
TaskCreate, TaskGet, TaskList, TaskUpdate
```

| Capability | Code authority |
| --- | --- |
| Contract generation and catalog digest | `packages/tool-contracts/` |
| Common locking, policy and permission pipeline | `packages/tool-runtime-product/` |
| Filesystem tools | `packages/tools-fs/` |
| Process/search tools | `packages/tools-process/` |
| Web tools | `packages/tools-web/` |
| Questions and plan transitions | `packages/tools-interaction/` |
| Skills, agents and background work tools | `packages/tools-agent/` |
| Durable task graph | `packages/task-graph/` |

The generated `specs/contracts/canonical-tools-v1.md` is a readable projection, not a handwritten authority.

## 4. State and concurrency

Operation birth freezes the catalog, permission, component, workspace, execution-environment, plan, and origin revisions used by every call. Tool concurrency follows the contract: independent reads may run in parallel, canonical-path mutations serialize, and Session-state changes use Session-level admission. Cancellation flows through the same owned call record and cleanup path.

`Write` and `Edit` can participate in root managed-file checkpoints. Bash, Host tools, MCP, child work, and external filesystem effects are deliberately outside that rollback claim.

## 5. Plan, task and child work

Plan mode has one product owner and contributes a monotonic guard to `ctx.tools`. TaskGraph state is durable in the DSH Session event vocabulary. Child and background work executes through DSH subagent/jobs primitives while the MyAgents WorkRegistry adds product identities, permission/origin restrictions, settlement, messaging, stop, and recovery behavior.

## 6. Changes and verification

A tool change must update the handwritten contract source, generated catalog/schema/fixtures, product profile digest, implementation, permission and cancellation tests, packed-runtime conformance, and any affected handoff. Do not edit generated Markdown or JSON directly. New definitions are not public merely because a plugin can register them; the exact official profile and compatibility manifest must admit them.
