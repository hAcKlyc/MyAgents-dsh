---
type: technical-architecture
status: implemented
module: child-agents-and-background-work
updated: 2026-09-02
product_scope: ../../prd/prd_0.1_agent_runtime.md
implementation_decision: ../../prd/tech_rfc_0.1_runtime_architecture.md
patch_authority: ../../dsh/seam-decisions-v1.json
---

# Child agents and background work

## 1. Purpose and authority

This guide explains how the canonical `Agent`, `SendMessage` and `TaskStop` tools project DSH subagents and local Jobs into durable Product work. DSH `SubagentRuntime`, in-process spawn and Jobs own native child/process primitives; `packages/tools-agent/src/work-runtime.ts` owns Product identity, role catalogs, foreground/background behavior, messaging, retained output and restart recovery.

## 2. Relationships

- **Owns:** Product work identities, child descriptors/personas/catalogs, foreground or continuable mode, parent/child messaging, retained output and terminal/recovery projection.
- **Depends on:** DSH Agent/Session/Subagent/Jobs services, operation-frozen model/tool/config authority, root permissions/TaskGraph and canonical tools.
- **Consumed by:** root and child `Agent`, `SendMessage`, `TaskStop`, Host event projection and resume recovery.
- **Does not own:** another AgentLoop, nested child spawning, independent permission/task state, an OS sandbox or rollback for child file/process effects.

## 3. Child roles and capability boundary

The current profile admits child depth one. It always provides two built-in roles and may add dynamic Agent roles from the frozen effective component generation:

| Role | Tool surface | Intended behavior |
| --- | --- | --- |
| `general` | eligible operation-frozen catalog minus hard child exclusions | delegated implementation or general work under normal Product permission/policy |
| `Explore` | `Read`, `Glob`, `Grep`, `ls`, `Bash`, `WebFetch`, `WebSearch`, `Skill`, `TaskGet`, `TaskList`, `SendMessage`, `TaskStop` when those tools are available | read-only research, with a literal persona that restricts Bash to inspection commands |
| dynamic Agent role | deterministic intersection of its declared `tools`/`disallowedTools` and the effective operation catalog | component-owned persona, optional Skills and bounded `maxTurns`; an optional `modelProfileRef` selects only the already frozen birth profile |

Every role is prevented from spawning another child Agent. The Explore restriction intentionally aligns with Claude Code's useful research surface: Bash is present, while the role prompt and ordinary Product policy constrain its use. It is not an OS-level read-only sandbox; the security guide states the consequence explicitly.

The effective catalog can expose Web tools to a child, but current backend authority is not fully
parity-safe: DeepSeek Runtime-local `WebFetch` works, while child DeepSeek `WebSearch` and
non-DeepSeek Host-backed Web tools currently compare the child id with the root Provider binding
and fail stale/backend admission. This is a documented implementation gap, not an intentional role
restriction; see [Web and network](../boundaries/web-and-network.md).

Visibility and execution remain separate. Every child call re-enters the same DSH `ctx.tools`/PreToolUse/PostToolUse pipeline. Inherited canonical/component tools check their frozen catalog, workspace roots, origin, Plan, permission and hard policy. Child-scope `TaskStop` and `SendMessage` are coordination exceptions: they authorize through exact WorkRegistry lineage instead of Product permission/PermissionRequest/Plan. Root and children share one root-Session durable Plan, permission rules and TaskGraph; UI interactions identify the executing child.

`Agent` and `EnterPlanMode` are root-only for every child. Background children are also origin-policy denied `AskUserQuestion` and `ExitPlanMode` because they cannot synchronously own a Host interaction. A foreground child may reach otherwise eligible interaction tools; Provider availability, Product permission and the Agent-scoped single-flight interaction owner still decide the call. A permission prompt may therefore originate from a child even though any durable permission rule and the Plan remain root-owned.

## 4. Work lifecycle

```text
Agent tool call with exact operation authority
  -> choose role and foreground/background mode
  -> inherit the exact parent Provider/model and validate any role model constraint
  -> publish Product work intent and DSH child Session descriptor
  -> start child in the current Runtime process
  -> stream/retain bounded output and usage
  -> foreground: return terminal result to the call
     background: return work id and continue independently
  -> settle one Product work terminal and retire owned child resources
```

Background mode uses a continuable DSH child and retained output authority. Foreground mode waits for the child epoch and returns it as the tool result. Both have exact child Session boundaries and idempotent Product work identities.

## 5. Messaging and stopping

`SendMessage` can deliver root-to-child, child-to-parent and child-to-sibling messages inside one exact root-work lineage. Intent and insertion identities are durable so replay cannot duplicate or redirect a message. A live follow-up starts another bounded child epoch; a report is correlated into the root Inbox and operation flow. It is not cross-Session messaging and does not provide broadcast, team or cloud delivery.

`TaskStop` stops an owned child Agent or background process and waits for terminal cleanup. Child self-stop that would synchronously destroy its own active call is rejected. Process termination and child abort use different internal terminal vocabularies; Host presentation may normalize them, but recovery retains exact owner semantics.

## 6. Recovery and limits

Resume reconstructs Product work records from root events, validates every child Session parent/origin/epoch boundary and correlates pending Inbox entries. Recoverable continuable work resumes through public DSH seams. A durable ProductWork owner whose required child Session is missing fences recovery; retained output from a pre-accept orphan is cleaned up instead of being promoted into a recovery claim. Ambiguous open turns, reused message identities or ownership drift also remain failures.

The current generation-wide bounds are explicit:

- child depth: `1`;
- Product work items, including terminal records: `256` per root generation;
- collaboration messages: `1,024`, with at most `4 MiB` cumulative message content;
- epochs: at most `1,025` per work item, additionally bounded by the role's `maxTurns`, and `1,280` total per generation;
- retained background output: `8 MiB`;
- inline terminal result: `256 KiB`.

Managed-file rollback excludes child effects even though child file tools pass through ordinary policy. Failure of one background interaction-only call does not automatically terminate unrelated children or components.

## 7. Architecture-correct change path

Add a role as declarative capability policy plus a literal persona and deterministic catalog derivation. Keep child execution in DSH subagent services and Product orchestration in `ProductWorkService`. To make a role truly read-only against a hostile model, add an execution-time hard tool/argument policy or OS containment owner; prompt wording alone cannot provide that claim. Extend durable events/folds only when restart requires new state, and cover follow-up, stop, cancellation, crash and retained-output cleanup.

## 8. Verification and implementation map

| Concern | Source or evidence |
| --- | --- |
| Product roles/work/messaging/recovery | `packages/tools-agent/src/work-runtime.ts` |
| Official child lifecycle | pinned `@deepseek-ai/dsh-subagent`, `dsh-subagent-spawn-in-process`, `dsh-jobs-local` |
| Child publication gate | `packages/runtime-product/src/composition.ts`, `primary-session.ts` |
| Canonical schemas | `packages/tool-contracts/` |
| Patch dependencies | DSH patches `0001`, `0003`, `0004`, `0005`, `0008` and `specs/dsh/seam-decisions-v1.json` |
| Tests | `tests/product-work-tools.unit.test.ts`, `tests/product-declarative-components.unit.test.ts`, packed Runtime recovery and dynamic campaigns |
