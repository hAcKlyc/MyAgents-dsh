---
type: technical-architecture
status: implemented
module: tool-runtime-and-policy
updated: 2026-09-04
product_scope: ../../prd/prd_0.1_agent_runtime.md
implementation_decisions:
  - ../../prd/tech_rfc_0.1_agent_experience.md
  - ../../prd/tech_rfc_0.1_dsh_capability_map.md
  - ../../prd/tech_rfc_0.3_myagents_dsh_runtime_capability_closure.md
---

# Tool runtime and policy

## 1. Purpose and authority

This module owns the canonical Agent experience exposed by the official Runtime: tool definitions, visibility, policy, permissions, execution, output, plan/task state, and child/background work. Exact tool schemas and behavior fixtures come from `packages/tool-contracts/src/contract-source.ts` and generated artifacts.

### 1.1 Relationships

- **Owns:** canonical model-visible tool definitions, common execution context, schema validation, hard policy, origin/workspace checks and dispatch through DSH `ctx.tools`.
- **Depends on:** operation birth authority, permissions/Hooks/Plan, canonical executor plugins, component contributions and DSH ToolRuntime.
- **Consumed by:** root/child Agents, Host catalogs, compatibility manifests and tool acceptance campaigns.
- **Does not own:** model routing, OS containment, Host Tool implementation, Session persistence or permission UI.

## 2. Single execution pipeline

All model-visible tools register into the one DSH `ctx.tools` registry and execute through one ToolRuntime. A MyAgents compatibility tool may replace a stock DSH definition, but it does not create a parallel tool engine.

```text
visible definition + frozen operation scope
  -> parse and losslessly snapshot original model input
  -> governed PreToolUse transform
  -> validate transformed input against the visible definition
  -> commit authoritative assistant/tool-call representation
  -> DSH ToolRuntime scheduling and body dispatch
       -> canonical input validation
       -> operation / catalog / origin / Plan guards
       -> tool-specific workspace / identity guards
       -> permission, PermissionRequest Hook and interaction without a human-decision deadline
       -> post-authorization executor deadline
       -> current-authority revalidation and execution
       -> canonical output validation
  -> PostToolUse transform and transformed-output validation
  -> durable DSH tool result
```

Visibility and permission remain separate. Hiding a tool does not authorize execution, and a visible definition still revalidates workspace, revision, mode, origin, and hard policy at the delayed execution boundary.

Human waiting is not execution time. Permissionable definitions do not publish a DSH outer timeout that would begin before authorization. Their implementation enters the bounded executor only after the exact permission decision settles. Transport registration/response, network/provider calls, MCP calls, process work and cleanup retain their own bounded owners.

The four permission modes, durable exact-rule lifecycle, blocking interaction path and Host-controlled Plan transition are specified in [Permissions and interactions](./permissions-interactions-and-plan.md). This guide owns their placement in the tool pipeline; that guide owns their detailed policy semantics.

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
| Bash and managed process/search executor | `packages/tools-process/` |
| Web tools | `packages/tools-web/` |
| Questions and plan transitions | `packages/tools-interaction/` |
| Skills, agents and background work tools | `packages/tools-agent/` |
| Durable task graph | `packages/task-graph/` |

The generated `specs/contracts/canonical-tools-v1.md` is a readable projection, not a handwritten authority.

TaskUpdate can omit model-input `owner` when entering `in_progress`. The root-Session TaskGraph serializes the transition and records the registered caller as owner only when the task is unassigned. New durable events bind `actorId` to the exact root/child origin; legacy events retain their historical fold and revision. Root or the current owner may explicitly transfer a nonterminal task to root or a registered child of that same root. A competing claimant, foreign/unregistered caller or target cannot publish a transition. This source change is covered by `tests/product-task-graph.unit.test.ts`; it does not change the current Write directory/checkpoint coverage.

## 4. State and concurrency

Operation birth freezes the catalog, permission, component, workspace, execution-environment, plan, and origin revisions used by every call. Tool concurrency follows the contract: independent reads may run in parallel, canonical-path mutations serialize, and Session-state changes use Session-level admission. Cancellation flows through the same owned call record and cleanup path.

Grep accepts either a file or directory. Search authorization records stable filesystem identity;
normal child creation, Edit publication, or mtime changes inside an authorized directory do not
invalidate a parallel search, while replacement of the authorized root/file still does. Bash uses
the explicit non-secret environment admitted at Session birth. A TaskStop signal settles a
background Bash job as `aborted`; a natural non-zero exit settles as `failed`.

`Write` creates missing parents inside the operation-frozen write roots before publishing its one
file mutation. The checkpoint owner persists the missing-parent plan before the first mkdir and
records each created directory identity before proceeding. The selected filesystem Provider checks
canonical paths, real directories and parent identity; aliases, replacement races and unknown
creation receipts cannot authorize file publication. `ls` retains `directory_not_found` for an absent
root. The generated canonical contract owns these exact tool descriptions and error codes.

Root `Write` and `Edit` participate in managed-file rewind. New-file child `Write` uses internal checkpoint
records for directory preparation, cancellation and crash recovery, keyed by its own DSH Session;
its result does not advertise a root checkpoint receipt. Root rewind still excludes child, Bash,
Host/MCP and external changes. Directory cleanup and rewind compensation are documented in
[Mutations and checkpoints](../state/mutations-and-checkpoints.md#8-checkpoint-coverage-and-limits).

## 5. Plan, task and child work

Plan mode has one product owner and contributes a monotonic guard to `ctx.tools`. TaskGraph state is durable in the DSH Session event vocabulary. Child and background work executes through DSH subagent/jobs primitives while the MyAgents WorkRegistry adds product identities, permission/origin restrictions, settlement, messaging, stop, and recovery behavior.

### 5.1 Portable Task metadata

`TaskCreate` and `TaskUpdate` expose one bounded flat metadata record. Each key is non-empty and bounded, and each value is exactly one JSON scalar: string, finite number, boolean, or `null`. Arrays, nested objects, schema references, and recursive values are rejected. On `TaskUpdate`, `null` deletes the named key; the other scalar values replace it.

This restriction is part of the canonical Runtime tool contract, not a Provider-specific rewrite. The same non-recursive model-visible schema is sent through Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses. Structured product meaning belongs in versioned named Task fields rather than an arbitrary nested metadata bag. The contract and TaskGraph packages own this rule; DSH Core supplies the common tool and Session seams but does not define Task metadata.

### 5.2 Child roles and Product authority

`Agent` creates a DSH child Session and records one immutable effective role. `general` inherits every eligible tool in the parent operation-frozen catalog except depth-one hard exclusions. `Explore` exposes Read, Glob, Grep, `ls`, Bash, WebFetch, WebSearch, Skill and read/coordination Task tools; Write, Edit, task mutation, Plan interaction and nested Agent creation are absent. Bash remains the ordinary governed Bash tool and the Explore persona restricts it to read-only inspection. The Runtime does not parse shell commands or claim an OS read-only sandbox in this phase.

Declarative Agent roles may specify `tools`, `disallowedTools` and `maxTurns`. Omitted `tools` means inheritance; the allowlist can only select definitions already visible to the parent, and the denylist is applied afterward. Invocation selects a committed role name and cannot add an ad-hoc tool list.

Root, foreground-child and background-child calls all remain in the one DSH `ctx.tools`/ToolRuntime and PreToolUse/PostToolUse Hook pipeline. Inherited canonical and component tools also pass through `ProductToolRuntime`, Plan/origin guards and permission service. Two child-scope coordination definitions are deliberate exceptions: child `TaskStop` and `SendMessage` authorize through exact WorkRegistry lineage rather than Product permission/PermissionRequest/Plan. The child authority binds the exact child Session, parent Product operation, component generation, tool catalog and active child DSH turn. Product-owned durable state—permission rules, Plan and TaskGraph—remains on the root Product Session. Permission UI identifies the executing child while `always_allow` persists the shared root-Session rule. Background interaction-only tools still fail their individual call; they do not terminate the child, root turn or unrelated components.

`SendMessage` accepts `parent` as a reserved alias from a child. Background output is published incrementally to its retained output before terminal settlement. Managed-file checkpoint coverage remains root-origin Write/Edit only even though child writes use the same governed file and permission path.

## 6. Changes and verification

A tool change must update the handwritten contract source, generated catalog/schema/fixtures, product profile digest, implementation, permission and cancellation tests, packed-runtime conformance, and any affected handoff. Do not edit generated Markdown or JSON directly. New definitions are not public merely because a plugin can register them; the exact official profile and compatibility manifest must admit them.

## Trusted service callbacks

Composition-installed callbacks use ordinary Promise/thenable semantics. Promise subclasses, own observation fields and Proxy functions do not establish a security boundary inside trusted Runtime JavaScript. The tool service caches the parsed catalog by its immutable source identity and compares admitted revision/digest during execution. Model arguments, external RPC declarations, path/URL/attachment identity and post-approval policy checks retain their boundary validation.

A governed Edit without a current complete Read instructs the caller to run Read without offset or limit and then retry. This improves recovery guidance without changing ReadState authority or permitting a partial/stale read to authorize a mutation.
