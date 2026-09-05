---
type: technical-architecture
status: implemented
module: child-agents-and-background-work
updated: 2026-09-05
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
- **Does not own:** another AgentLoop, independent permission/task state, an OS sandbox or rollback for child file/process effects.

## 3. Child roles and capability boundary

The Host-configured maximum depth defaults to one (root depth zero) and supports one through eight. ProductWork records every descendant in the root ledger while DSH retains its actual direct parent. It provides three built-in roles and may add dynamic Agent roles from the frozen effective component generation:

| Role | Tool surface | Intended behavior |
| --- | --- | --- |
| `general` | eligible operation-frozen catalog minus hard child exclusions | delegated implementation or general work under normal Product permission/policy |
| `Explore` | `Read`, `Glob`, `Grep`, `ls`, `Bash`, `WebFetch`, `WebSearch`, `Skill`, `TaskGet`, `TaskList`, `SendMessage`, `TaskStop` when those tools are available | read-only research, with a literal persona that restricts Bash to inspection commands |
| `Plan` | the same bounded research tool surface as `Explore` | read-only analysis and an actionable implementation/verification plan |
| dynamic Agent role | deterministic intersection of its declared `tools`/`disallowedTools` and the effective operation catalog | component-owned persona, optional Skills and bounded `maxTurns`; an optional `modelProfileRef` participates in Host-authorized model selection before the child birth is persisted |

General and eligible dynamic roles may delegate below the configured maximum depth; their tool surface omits `Agent` at the limit. Explore and Plan retain their fixed non-delegating research surface. The Explore restriction intentionally aligns with Claude Code's useful research surface: Bash is present, while the role prompt and ordinary Product policy constrain its use. It is not an OS-level read-only sandbox; the security guide states the consequence explicitly.

The effective catalog can expose Web tools to a child. Provider and reverse-request identity now
bind to the root Agent, while call identity and policy remain those of the executing child; see
[Web and network](../boundaries/web-and-network.md) for backend selection and tested boundaries.

Visibility and execution remain separate. Every child call re-enters the same DSH `ctx.tools`/PreToolUse/PostToolUse pipeline. Inherited canonical/component tools check their frozen catalog, workspace roots, origin, Plan, permission and hard policy. Child-scope `TaskStop` and `SendMessage` are coordination exceptions: they authorize through exact WorkRegistry lineage instead of Product permission/PermissionRequest/Plan. Root and children share one root-Session durable Plan, permission rules and TaskGraph; UI interactions identify the executing child.

`EnterPlanMode` remains root-only. `Agent` additionally requires an eligible frozen role catalog and available depth. Background children are also origin-policy denied `AskUserQuestion` and `ExitPlanMode` because they cannot synchronously own a Host interaction. A foreground child may reach otherwise eligible interaction tools; Provider availability, Product permission and the Agent-scoped single-flight interaction owner still decide the call. A permission prompt may therefore originate from a child even though any durable permission rule and the Plan remain root-owned.

## 4. Work lifecycle

```text
Agent tool call with exact operation authority
  -> choose role and foreground/background mode
  -> select and freeze the Host-authorized Provider/model and role constraints
  -> persist reserved Product identity, immutable birth and bounded output authority
  -> wait in the root capacity FIFO if all execution slots are occupied
  -> start the exact reserved DSH child identity and persist its initial Inbox boundary
  -> stream/retain bounded output and usage
  -> foreground: return terminal result to the call
     background: return work id and continue independently
  -> record one completed activation and deliver its bounded parent report
  -> retain the child identity/context for follow-up; TaskStop closes the handle
```

Both modes use continuable DSH children. Omitted/true `run_in_background` returns a handle and retained output path; false waits for the first activation's durable result rather than handle closure. General, Explore, Plan and dynamic roles retain context after completion. Existing durable settlements remain closed facts. Protocol 2.6 source snapshots separate `activation` (stable child/start identity, ordinal and execution state) from `handleState` (open/stopping/closed). New reserved births use `myagents/work/created` before DSH materialization and `myagents/work/started` for the exact initial Inbox boundary. The initial activation identity is stable while queued; legacy child/start identities remain unchanged. Later native starts append `myagents/work/activated`, and durable epochs own completed output and usage. `myagents/work/phase` records the activation ordinal and queued/running/child/interaction/delivery wait transitions. An answered interaction may be queued for capacity before execution resumes. Closing an idle handle preserves the completed activation's result and timestamps.

## 5. Messaging and stopping

`Agent` accepts no caller-defined display name. Its result returns a `taskId` for `TaskStop` and a separate live `agentId` for `SendMessage`. A root or child addresses a known open collaborator anywhere in the same tree by that `agentId`; a child resolves the reserved literal `parent` to its actual direct parent. Durable ancestry is validated before cold materialization. TaskGraph owner claims use the same tree membership without exposing another branch's transcript. Task IDs, names, broadcasts, team aliases, cross-Session recipients and stopping/terminal Agents are not messaging identities. A `queued` result is ordered mailbox admission, not execution completion. New explicit child messages freeze the separate collaboration policy: realtime (default) uses the next DSH step boundary, turn uses the next child-turn boundary. Retries preserve the original timing. Intent and insertion identities are durable so replay cannot duplicate or redirect a message. A live follow-up starts another bounded child epoch; a report is correlated into the root Inbox and operation flow.

`TaskStop` stops an owned child Agent or background process and waits for terminal cleanup. Stopping a node drains its complete subtree while preserving unrelated branches. A child cannot synchronously stop itself or an ancestor, since either action would destroy the active stop call. Process termination and child abort use different internal terminal vocabularies; Host presentation may normalize them, but recovery retains exact owner semantics.

Every durable epoch produces one bounded automatic completion report for its actual direct parent through the public quiet `inject`/DSH Inbox seam. A deterministic epoch-owned message intent precedes insertion; the existing delivery receipt records the exact DSH message identity. A closed ancestor cancels pending report delivery without reopening its Agent. Canceled explicit deliveries use `myagents/work/message-canceled`, so stopping queued work cannot permanently obstruct later messages. Reports identify child, task, epoch and outcome, and are distinct from explicit `SendMessage` content. Recovery reuses an existing insertion or completes the missing step, including when the resident child scope is absent. It does not wake a second AgentLoop. Host cold history reconstructs Provider activity and child lifecycle from native events, preserves original tool results, and marks timing unavailable when session/read omits event timestamps. User restoration of a closed context and operation-aware realtime report delivery remain open implementation work; source gates here do not claim packaged acceptance.

## 6. Recovery and limits

Resume reconstructs Product work records from root events, validates every child Session parent/origin/epoch boundary and correlates pending Inbox entries. Recoverable continuable work resumes through public DSH seams. `withContinuableAncestors` temporarily restores the exact direct-parent chain without adding prompts or starting ancestor activations. A committed ancestor stop also closes descendants whose individual stop receipts were interrupted by a crash. A reserved birth can recreate its not-yet-materialized child using the original durable tool call and frozen model, through the same bounded capacity FIFO; a legacy or started ProductWork owner whose required child Session is missing fences recovery; retained output from a pre-accept orphan is cleaned up instead of being promoted into a recovery claim. Ambiguous open turns, reused message identities or ownership drift also remain failures.

The current generation-wide bounds are explicit:

- child depth: default `1`, configurable through `8`;
- actively executing children, including admitted starts: default/hard ceiling `32`; Host may lower it. Creation, cold recovery and follow-up share the same FIFO. Idle handles and children awaiting delegated work, delivery or human interaction release execution capacity and must reacquire it before continuing; cancellation/TaskStop of a queued birth closes it durably without waiting for capacity;
- Product work items, including terminal records: `256` per root generation;
- explicit collaboration messages: `1,024`, with at most `4 MiB` cumulative content; up to `1,280` additional epoch reports each bounded to `4 KiB` have separate capacity;
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

## Explicit Host control and continuation

The trusted native `work/agent/resume` port appends `myagents/work/reopened`, naming the exact previous settlement and Host request identity. It preserves DSH Session identity, birth model, previous epochs and results; it opens the handle without injecting a prompt or waking closed descendants. Ancestors must be open and the selected model still authorized. `work/agent/message` supplies a separately identified follow-up; `work/agent/stop` rejects an obsolete handle revision after a user reopen. These are Host ports, never model-visible tools. Old automatic reports and SendMessage cannot clear a settlement. `handleRevision` is derived from durable lifecycle positions, allowing the client to distinguish an explicit reopen from an old open snapshot.

Late descendant completion targets its actual direct parent through the native continuation seam, including a later parent activation when necessary. An idle Root report is admitted through the SDK operation service as collaboration-origin work, retaining its actual child source and exact native Inbox identity. Parent activation limits suppress further automatic activation with an explicit message cancellation. Human input and collaboration retain separate timing policies.

### Host tree observation

`work/list` reads only the published primary root's retained Work entries. Creation-order pages use the last included Task ID as the cursor; cursor ownership is checked against that root. At most four public SessionQuery observations are held concurrently and every lease is disposed. The response obeys negotiated frame limits, caps pages at 32 entries, and limits each result preview to 1,024 characters. Full retained output remains owned by the existing Work output path/tool. Model route and context facts come from the child birth and the official token/context projections; missing Provider usage stays unknown. The root Work index is disposable and incrementally rebuilt from native facts.

Completed Agent usage excludes inherited events and is derived from official DSH turn-attempt accounting, with each compaction summary/repair aggregate added once. Missing provider buckets omit usage, including successful foreground results; they do not create zero totals or fail valid results. Live tree observations use official projections with inherited-prefix subtraction and report only provable complete bucket counts.
