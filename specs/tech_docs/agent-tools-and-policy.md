---
type: technical-architecture
status: implemented
module: agent-tools-and-policy
updated: 2026-08-31
product_scope: ../prd/prd_0.1_agent_runtime.md
implementation_decisions:
  - ../prd/tech_rfc_0.1_agent_experience.md
  - ../prd/tech_rfc_0.1_dsh_capability_map.md
  - ../prd/tech_rfc_0.3_myagents_dsh_runtime_capability_closure.md
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

### 5.1 Portable Task metadata

`TaskCreate` and `TaskUpdate` expose one bounded flat metadata record. Each key is non-empty and bounded, and each value is exactly one JSON scalar: string, finite number, boolean, or `null`. Arrays, nested objects, schema references, and recursive values are rejected. On `TaskUpdate`, `null` deletes the named key; the other scalar values replace it.

This restriction is part of the canonical Runtime tool contract, not a Provider-specific rewrite. The same non-recursive model-visible schema is sent through Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses. Structured product meaning belongs in versioned named Task fields rather than an arbitrary nested metadata bag. The contract and TaskGraph packages own this rule; DSH Core supplies the common tool and Session seams but does not define Task metadata.

### 5.2 Child roles and Product authority

`Agent` creates a DSH child Session and records one immutable effective role. `general` inherits every eligible tool in the parent operation-frozen catalog except depth-one hard exclusions. `Explore` exposes Read, Glob, Grep, `ls`, Bash, WebFetch, WebSearch, Skill and read/coordination Task tools; Write, Edit, task mutation, Plan interaction and nested Agent creation are absent. Bash remains the ordinary governed Bash tool and the Explore persona restricts it to read-only inspection. The Runtime does not parse shell commands or claim an OS read-only sandbox in this phase.

Declarative Agent roles may specify `tools`, `disallowedTools` and `maxTurns`. Omitted `tools` means inheritance; the allowlist can only select definitions already visible to the parent, and the denylist is applied afterward. Invocation selects a committed role name and cannot add an ad-hoc tool list.

Root, foreground-child and background-child calls all execute through the same `ctx.tools` definitions, `ProductToolRuntime`, Hooks and permission service. The child authority binds the exact child Session, parent Product operation, component generation, tool catalog and active child DSH turn. Product-owned durable state—permission rules, Plan and TaskGraph—remains on the root Product Session. Permission UI identifies the executing child while `always_allow` persists the existing exact rule on that root Session. Background interaction-only tools still fail their individual call; they do not terminate the child, root turn or unrelated components.

`SendMessage` accepts `parent` as a reserved alias from a child. Background output is published incrementally to its retained output before terminal settlement. Managed-file checkpoint coverage remains root-origin Write/Edit only even though child writes use the same governed file and permission path.

## 6. Changes and verification

A tool change must update the handwritten contract source, generated catalog/schema/fixtures, product profile digest, implementation, permission and cancellation tests, packed-runtime conformance, and any affected handoff. Do not edit generated Markdown or JSON directly. New definitions are not public merely because a plugin can register them; the exact official profile and compatibility manifest must admit them.
