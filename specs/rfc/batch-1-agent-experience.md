---
type: technical-rfc
status: draft
batch: 1
workstream: B1-W2
updated: 2026-08-15
depends_on:
  - ../prd/batch-1-agent-runtime.md
  - ./batch-1-runtime-rpc.md
  - ./batch-1-dsh-capability-map.md
---

# Batch 1 Agent Experience implementation RFC

## 1. Purpose

This RFC defines how the canonical MyAgents Agent experience is implemented as first-party DSH modules. It covers the exact catalog authority, the common tool pipeline, the canonical twenty tools, permission and interaction, plan state, Skills, child/background work, TaskGraph, managed-file observation, and the one DSH seam that current public APIs cannot express.

The product contract, engine-neutral tool implementation, and synthetic fixtures are migrated from the implemented `myagents-runtime` authorities under the plan's reuse-before-rewrite policy. The old repository is not a runtime dependency: Pi registration/context/event glue is replaced by DSH-native modules, while reusable tool bodies and helpers may be copied and adapted.

## 2. Source evidence

The design was initially checked against DSH `47f943859bef` / `0.1.0-rc.5` and re-audited by `B1-DSH-R1` against `b150a551b8d4` / `0.1.1-rc.2`; the current capability delta and patch dispositions are recorded in `../dsh/upstream-rebaseline-0.1.1-rc.2.md`:

- `@deepseek-ai/dsh-tools` exposes the single scoped `ToolRuntime`, `ToolDefinition`, restrictions, monotonic guards, pre/around/post waterfalls, final content, presentation, timeout metadata, and a boolean parallel/exclusive classifier;
- AgentLoop appends `assistant/message` before scheduling its tool calls, then appends each `tool/call` immediately before `ToolRuntime.prepare()`;
- `tools/pre-execute` can return only `allow`, `deny`, or `ask`; arguments and call identity are already immutable;
- DSH filesystem, shell, web, question, approval, plan, Skill, jobs, and subagent services expose usable public Provider/registration seams;
- DSH `todo_write` is a transient list and cannot implement the accepted dependency-aware TaskGraph contract.

The old 20-tool technical RFC contributes exact schemas, descriptions, success values, error vectors, concurrency classes, bounds, checkpoint scope, and E2E cases. Those are migration inputs until regenerated into the new canonical source.

## 3. Decisions

1. The official model-visible catalog contains exactly the canonical twenty implementation names. Stock DSH model tools are not mounted.
2. Every built-in, dynamic Host, and MCP tool executes through the same DSH `ctx.tools` pipeline.
3. Product code reuses lower DSH services and public pure helpers when their semantics match; it owns every compatibility `ToolDefinition`.
4. Hard policy is monotonic. A Hook, permission answer, component, child, or Provider can reduce authority but cannot widen operation-frozen roots, origin, generation, revision, plan, network, or secret policy.
5. A minimal pre-assistant-commit transform seam is required for authoritative `PreToolUse.updatedInput`. No proxy/inner call or split audit is allowed.
6. DSH remains the scheduler. Product keyed locks refine DSH's parallel class; they do not create a second tool dispatcher.
7. TaskGraph and product work facts are required non-surface DSH Session events and therefore depend on the product-event persistence seam in the Runtime RFC.
8. Managed rewind coverage is exactly root-origin canonical `Write` and `Edit`.

## 4. Package ownership

```text
packages/tool-contracts/
  contract-source.ts       sole handwritten catalog authority
  schema.ts                shared schema builders and bounds
  generated/               descriptors, JSON schema, fixtures, digests

packages/tool-runtime-product/
  operation-context.ts     call -> frozen operation/component/origin
  visibility.ts            scoped catalog restrictions
  hard-guards.ts            fail-closed product invariants
  input-transform.ts       adapter to the DSH pre-commit seam
  permission.ts            policy and approval resolution
  keyed-locks.ts            path/resource concurrency refinement
  output-policy.ts         canonical bounds, redaction, spill references

packages/tools-fs/          Read Write Edit Glob Grep ls
packages/tools-process/     Bash + WorkRegistry bridge
packages/tools-web/         WebFetch WebSearch
packages/tools-interaction/ AskUserQuestion + plan tools
packages/tools-agent/       Skill Agent TaskStop SendMessage
packages/task-graph/        TaskCreate TaskGet TaskList TaskUpdate + fold
```

The package split is an ownership aid, not a requirement for one npm package per group. Generated projections are never edited directly.

## 5. Canonical contract source

### 5.1 Handwritten authority

`packages/tool-contracts/src/contract-source.ts` must define, for each tool:

```ts
type CanonicalToolContract = {
  name: CanonicalToolName
  description: string
  inputSchema: JsonSchemaNode
  outputSchema: JsonSchemaNode
  concurrency: 'parallel' | 'session_serial' | 'canonical_path'
  sideEffect: 'read' | 'workspace' | 'process' | 'network' |
    'interaction' | 'delegation' | 'session_state'
  timeoutMs?: number
  outputLimits: ToolOutputLimits
  permissionClass: PermissionClass
  checkpoint: 'none' | 'root_managed_file'
  behaviorFixtureIds: readonly string[]
}
```

The source emits exact DSH definitions, protocol metadata, catalog fixtures, behavior vectors, documentation tables, and a deterministic digest. A build fails if the emitted model catalog has a missing, extra, duplicate, or non-deterministically ordered name.

### 5.2 Fixed catalog

```text
Read, Write, Edit, Glob, Grep, Bash, ls,
WebFetch, WebSearch, AskUserQuestion, EnterPlanMode, ExitPlanMode,
Skill, Agent, TaskStop, SendMessage,
TaskCreate, TaskGet, TaskList, TaskUpdate
```

Aliases may exist only outside the model catalog in an explicit protocol/SDK compatibility layer. The DSH stock names are not silently exposed beside these names.

### 5.3 Definition construction

One `defineCanonicalTool(contract, body)` builder:

- passes only `name`, `description`, and the exact input schema to the model;
- validates canonical values against the output schema;
- renders deterministic bounded model content;
- attaches replayable presentation metadata without secrets or unbounded raw bodies;
- sets timeout and the DSH concurrency classifier;
- turns expected product errors into stable canonical error results;
- lets DSH normalize unexpected throws and cancellation.

It does not execute policy or checkpoints inside the builder. Those are shared pipeline modules.

## 6. Operation and call context

Every top-level DSH execution must resolve one immutable `ProductToolContext`:

```ts
type ProductToolContext = {
  generationId: string
  sessionId: string
  productTurnId: string
  clientOperationId: string
  dshTurn: number
  rootCallId: string
  callId: string
  origin: RootOrigin | ChildOrigin
  birth: OperationBirthSnapshot
  catalog: EffectiveCatalogSnapshot
  signal: AbortSignal
}
```

The operation service binds the active DSH Agent and claimed turn to the snapshot. Tool guards resolve by `exec.agent`, call identity, and current DSH turn; missing, ambiguous, stale, or terminal ownership fails before the body. Nested tool transports propagate `rootCallId` and cannot manufacture root authority.

Child Agents receive a derived immutable policy. Root-only checkpoint, interaction, attachment, mutation, and configuration authority is absent unless a specific product rule grants it.

## 7. Common execution pipeline

The normative order is:

```text
catalog visibility + active operation ownership
  -> original input-schema validation
  -> pre-commit Host Hook transformation
  -> transformed input-schema validation
  -> authoritative assistant message + tool/call persistence
  -> DSH execution mode and ordered scheduling
  -> operation/generation/revision/origin hard guards
  -> path/plan/network/secret hard guards
  -> permission rule / approval
  -> DSH around-execute timeout, cancellation, metrics
  -> canonical tool body
  -> output-schema validation and bounds
  -> PostToolUse policy/context
  -> definition finalization
  -> DSH durable tool/result in model order
  -> Runtime event projection
```

Every re-entry point repeats the current hard guards. Passing visibility or an earlier check never acts as an execution capability.

### 7.1 Authoritative transformed-input seam

The pinned DSH order cannot implement `updatedInput`: `assistant/message` contains the original raw tool-call arguments before `tools/pre-execute` runs. Rewriting only the execution object would make replay, audit, UI, and behavior disagree.

The preferred upstream-ready seam is one AgentLoop waterfall after assistant stream assembly and before `assistant/message` append:

```ts
type PreparedAssistantToolCall = {
  callId: CallId
  name: string
  rawArguments: string
  parsedArguments: unknown
}

type PreparedAssistantCommit = {
  message: AssistantMessage
  toolCalls: readonly PreparedAssistantToolCall[]
}

'agent/pre-assistant-commit'(
  input: Readonly<PreparedAssistantCommit>,
  next: () => Promise<PreparedAssistantCommit>,
): Promise<PreparedAssistantCommit>
```

The seam must:

- permit only argument replacement for existing call IDs/names and non-tool content byte identity;
- process calls in model order and return one complete immutable commit plan;
- validate lossless JSON and rebuild both the assistant tool-call block and scheduler input from the same value;
- observe the step AbortSignal and leave no registration/promise after cancellation;
- append nothing if it fails or is cancelled; existing DSH crash repair owns the streamed-chunk/open-step tail;
- remain a no-op with identical behavior when no listener is installed.

Product logic invokes only declared `PreToolUse` Hooks here. Permission and hard-policy decisions remain later in `ctx.tools`. Because an assistant message may contain parallel calls, every input transform is prepared before any of those calls executes; Hook ordering and this batching fact are part of the compatibility manifest.

An executable spike must prove success, denial, timeout, cancellation, invalid transformed JSON/schema, multi-call ordering, replay equivalence, repair, HMR, and no-listener equivalence before the fork is accepted. The patch is kept as one upstreamable commit and private imports remain forbidden.

### 7.2 Permission

The DSH pre-execute waterfall is the enforcement point after hard guards:

1. find an exact operation-frozen rule;
2. if denied, return a stable denial;
3. if approval is required, submit an identified request through the approval service;
4. revalidate operation, call, catalog, path/resource identities, and expected revision after the await;
5. allow once or record a bounded durable rule only when the response explicitly permits it.

Missing Providers, timeouts, stale replies, Host disconnects, and malformed results deny. `always_allow` is constrained by tool class, canonical target/resource, origin, Session, policy revision, and expiry; it never overrides hard policy.

### 7.3 Output and durable ordering

Bodies return canonical JSON values. The tool output renderer creates bounded model content; large eligible output spills only through an approved attachment/artifact reference with digest and preview. PostToolUse may replace a successful output only within the declared confidentiality and size contract, or block it with bounded feedback.

DSH emits a live `tools/result` before AgentLoop appends `tool/result`. Runtime completion projection therefore listens to the durable Session event for authoritative ordering. Live observation is diagnostics only.

### 7.4 Concurrency

DSH owns model-order barriers and the bounded parallel pool:

- `parallel`: return `true` from `isConcurrencySafe`;
- `session_serial`: omit/return false, creating a DSH exclusive barrier;
- `canonical_path`: opt into DSH parallel scheduling, then acquire a product keyed lock on the fully resolved canonical path immediately before the mutable critical section.

Keyed locks are abortable, FIFO per key, operation-owned, and removed when empty. Multiple path locks use canonical lexical order. No lock is held while waiting for human interaction. DSH still commits results in model order.

## 8. Filesystem and search tools

| Tool | DSH reuse | Product-owned behavior |
| --- | --- | --- |
| `Read` | public `FileSystem`, attachment/image limits and selected pure rendering helpers | exact schema/range/image result, canonical path, bounded bytes, ReadState observation |
| `Write` | public `FileSystem` primitives | exact create/replace contract, canonical-path lock, stale-state guard, checkpoint prepare, atomic publication |
| `Edit` | public `FileSystem` plus selected public string-replace helpers | exact-match/ambiguity semantics, ReadState guard, checkpoint and atomic publication |
| `Glob` | public DSH fs-search parsers/builders may be reused after fixture equality | exact pattern/root/exclusions/order/sample/bounds |
| `Grep` | public DSH fs-search helpers/subprocess seam may be reused | exact modes/context/order/match and output caps |
| `ls` | public `FileSystem` enumeration; stock definition only as behavior reference | exact retained Pi-compatible name/schema/result/order and entry caps |

Every path is resolved against operation-frozen approved roots, rejects NUL and unsupported encodings, and is revalidated against symlink/substitution immediately before access/publication. Runtime home, credential paths, and unrelated roots are excluded regardless of model input or Hook output.

### 8.1 ReadState

Successful `Read` and eligible search observations record a bounded in-memory state keyed by `(operation/session, canonical path)` with identity, size, mtime where reliable, and content digest. `Edit` requires the accepted compatibility precondition; `Write`/`Edit` re-read identity immediately before publication. ReadState is an optimistic concurrency fact, not a transcript or checkpoint.

### 8.2 Managed mutation handoff

For root canonical `Write`/`Edit`, the tool body calls the Workstream 4 checkpoint service before publication and settles its journal after publication. If checkpoint preparation or durable correlation fails, the file is not changed. Child, Bash, MCP, Host-tool, external, and manual mutations never claim managed coverage.

## 9. Bash and WorkRegistry

`Bash` is a compatibility definition over the selected public DSH `ShellExecutor`/subprocess capability. It owns:

- a sealed operation-frozen cwd and environment allowlist;
- explicit executable resolution and no credential-environment fallback;
- bounded command count, duration, stdout/stderr bytes, retained output, and process tree;
- fused caller/operation/timeout cancellation;
- kill plus await-quiescence before settlement;
- foreground and declared background result forms matching the canonical contract.

`WorkRegistry` is a product projection over DSH jobs and subagent handles, not a scheduler. It records stable product work IDs, kind, owner origin, DSH handle identity, state, result locator/preview, and settlement. Unknown or stale handles fail closed. Runtime terminal waits only for work classified as operation-blocking; retained background work stays under the Session owner and explicit limits.

## 10. Web tools

`WebFetch` and `WebSearch` are compatibility definitions over `ctx.web`. Only profile-approved Providers are registered.

WebFetch policy validates at every hop:

- `http`/`https` only, no URL credentials;
- normalized hostname and port policy;
- DNS answers against private, loopback, link-local, multicast, reserved, and product-denied ranges;
- redirect target and DNS rebinding checks;
- response status/type/declared and streamed size;
- decompression ratio, duration, redirect count, and cancellation.

WebSearch is unavailable unless an approved Provider and credential reference are effective. Queries/results are bounded; Provider bodies and secrets are normalized before model content or error projection. A stock DSH provider is direct-reusable only after the full security and result fixtures pass.

## 11. Interaction and plan tools

`AskUserQuestion` calls `ctx.userQuestions.ask()` with a stable interaction identity. The product provider registers the interaction before awaiting Host/local response and settles exactly once. Child origin may ask only when its descriptor and policy explicitly permit it.

`EnterPlanMode` and `ExitPlanMode` are compatibility definitions owned by `ProductPlanService`. The service appends a product ownership fact adjacent to the public DSH `plan/mode` event and cross-checks its projection with the public `foldPlanMode` helper. The stock `PlanModeController` is deliberately not installed: it also owns a stock exit tool, prompt text, and in-turn pending-state semantics that differ from this product contract. Plan state is included in each operation birth snapshot, while the exact operation that durably commits a transition may continue under the new revision; older concurrent operations remain stale. Enter is idempotent. Exit requires the accepted approval/interaction path. A monotonic `ctx.tools` guard applies the canonical per-tool plan policy to every definition, including later Host/MCP registrations, so direct calls and alternate registration paths cannot bypass it.

## 12. Skills

The product Skill Provider contributes immutable declarative definitions through `ctx.skills.registerProvider()` or `register()`:

- bounded metadata and text;
- approved resource base and digest;
- invocation policy and source identity;
- no JavaScript, package specifier, expression, shell expansion, or arbitrary import.

The canonical `Skill` definition uses the DSH Skill catalog/lookup/render services but owns the compatibility schema, visibility snapshot, result, and error rules. Loading a Skill adds bounded context through DSH's supported context path; it does not mutate the model catalog mid-operation.

## 13. Agent, TaskStop, and SendMessage

`Agent` uses the public DSH `SubagentRuntime` and DSH Agent factory/scope. A child birth manifest freezes descriptor digest, model route, allowed tools/roots/network/interaction, depth, parent operation, and component generation. Foreground, one-shot background, and continuable behavior are exposed only where the canonical contract declares them.

`TaskStop` resolves an owned product work ID, checks lineage and current state, invokes the public DSH job/subagent cancellation primitive, waits for the required quiescence boundary, and returns the canonical idempotent result.

`SendMessage` resolves an owned continuable collaborator, validates lineage/mode/state, allocates a durable message identity, and uses the public DSH follow-up/steer path matching the requested mode. Delivery receipt is not child completion. Cross-Session or stale-generation recipients are rejected.

DSH owns child AgentLoops and child Sessions. `WorkRegistry` adds product identity and projection only; it never mirrors child transcripts or schedules reasoning.

## 14. TaskGraph

### 14.1 State

TaskGraph folds required non-surface Session events into:

```ts
type TaskNode = {
  id: string
  subject: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  blockedBy: readonly string[]
  createdSeq: number
  updatedSeq: number
}
```

Planning event names are `myagents/task/created` and `myagents/task/updated`. Exact TypeBox/data schemas live beside the product Session-event source and are registered with the persistence known-event predicate.

### 14.2 Rules

- IDs are Runtime-generated and never reused within a Session generation.
- Dependencies must exist, cannot self-reference, and the resulting graph must remain acyclic.
- A blocked task cannot become `in_progress` or `completed` until prerequisites satisfy the frozen rule.
- Terminal transitions are monotonic except an explicitly versioned administrative recovery action, which is not model-facing.
- Writes are Session-serial and append one validated event; reads use the folded immutable projection.
- List order, filters, pagination/limit, and result bounds are deterministic.

`TaskCreate`, `TaskUpdate`, `TaskGet`, and `TaskList` are thin canonical definitions over this service. DSH `todo_write` is not loaded.

## 15. Failure model

Tool failures use stable product codes grouped as:

- contract/availability: unknown, hidden, invalid input/output, unavailable Provider;
- authority: no operation, stale generation/revision, forbidden origin, plan/policy denial;
- resource: path/network/process/attachment/work/task not found or conflict;
- lifecycle: cancelled, timeout, interaction stale, operation terminal, disposal;
- internal: bounded sanitized failure with correlation ID.

Model content is concise and actionable; structured Runtime events retain safe codes and identities. Neither path includes stack traces, credentials, full Host/Provider bodies, unapproved absolute paths, or private prompts.

## 16. Verification matrix

### 16.1 Every canonical tool

Each tool passes:

- catalog/schema/description/output golden fixture;
- valid minimum/typical/maximum input;
- invalid type, unknown field, over-limit, and hostile Unicode/encoding cases;
- visibility, stale operation, root/child, plan, and permission decisions;
- timeout/cancel before dispatch, during body, and after body before result commit;
- output-schema and output-bound failure;
- replayed call/result presentation identity;
- no secret/private-path leakage;
- clean disposal and zero orphan resource.

### 16.2 Group-specific

- path traversal, symlink swap, rename race, stale ReadState, concurrent same/different path;
- process tree, output flood, signal race, background retention and stop;
- SSRF literals/DNS/redirect/rebinding/decompression;
- interaction response/cancel/disconnect/revision races;
- plan direct-call bypass attempts;
- Skill path/digest/resource and injection cases;
- child depth/lineage/inheritance/foreground/background/resume races;
- TaskGraph cycles, invalid transitions, resume fold, long graph and corrupt events;
- checkpoint write-before/after every durable edge.

### 16.3 Pre-commit seam

The fork Spike additionally asserts that original input is nowhere executed after a successful transform, transformed input appears identically in assistant history, `tool/call`, presentation, permission, executor, result correlation, replay and resume, and a failed transform commits none of those identities.

## 17. Rejected alternatives

- Loading stock DSH tool bundles and renaming their UI labels: schemas, names, results, policy, and checkpoint behavior remain different.
- Running policy in each tool body: MCP/Host tools would bypass it and failures would occur after dispatch.
- Rewriting only `ToolExecution.arguments`: durable assistant history remains false.
- Registering a proxy tool that dispatches an inner transformed call: creates two identities/results and splits audit authority.
- Using `todo_write` for TaskGraph: no stable IDs, dependencies, partial mutations, or durable product contract.
- Creating a product child scheduler: DSH already owns jobs/subagent execution.

## 18. Acceptance conditions

This RFC is implementation-ready only when:

- the migrated canonical source and all twenty behavior fixture sets are reviewed and digest-stable;
- the pre-assistant-commit Spike and ADR are accepted or an equally authoritative public seam is proven;
- product required event persistence is proven for TaskGraph, plan, work, permission, and checkpoint facts;
- every selected DSH helper/Provider is covered by an exact reuse fixture rather than name similarity;
- the complete pipeline is demonstrated for built-in, Host, and MCP tools with one DSH `ctx.tools` authority;
- WorkRegistry and child behavior add no loop, scheduler, or transcript store.
